/** Shared authenticated relay transport. See README.md for delivery and encryption boundaries. */
import WebSocket from "ws";
import { ManagedRelayLease, RelaySocketHealth, RelayReconnectBackoff, relayUpgradeHeaders } from "./socket-lifecycle";
import { OutboundFrameQueue, sendEncryptedPayload } from "./outbound-scheduler";
import { openRelayMessage } from "./relay-inbound";
import { consumeTaskJobOffer, type TaskDispatchListener } from "./task-dispatch";
import { Payload, type Role } from "../protocol/schema";
import { peerPublicKeys } from "./crypto";
import type { PeerConfig, RelayClientOptions, SendOptions } from "./relay-client-types";
export type { PeerConfig, RelayClientOptions, SendOptions } from "./relay-client-types";
import { RelayMessageAcceptance } from "./replay-store";
import { sealEnvelope, sealSessionPayload } from "./relay-envelope";
export { sealEnvelope } from "./relay-envelope";
/** Return true only after this consumer has durably accepted the payload. */
type Listener = (p: Payload, peerPublicKey: string) => boolean | void | Promise<boolean | void>;

export class RelayClient {
  private ws?: WebSocket;
  private recipientRouting = false;
  private frames?: OutboundFrameQueue;
  private listeners = new Set<Listener>();
  private taskDispatchListeners = new Set<TaskDispatchListener>();
  private taskOfferListeners = new Set<(control: unknown) => void | Promise<void>>();
  private intentionalClose = false;
  private connectPromise?: Promise<void>;
  private reconnectTimer?: NodeJS.Timeout;
  private readonly reconnect: RelayReconnectBackoff;
  private readonly socketHealth = new RelaySocketHealth();
  private readonly admissionLease = new ManagedRelayLease();
  private readonly sessionKeys = new Map<string, string>();
  private readonly replay: RelayMessageAcceptance;

  constructor(
    private readonly cfg: PeerConfig,
    private readonly opts: RelayClientOptions = {},
  ) {
    this.reconnect = new RelayReconnectBackoff(opts.minReconnectMs, opts.maxReconnectMs);
    if (opts.onTaskDispatch) this.taskDispatchListeners.add(opts.onTaskDispatch);
    this.replay = new RelayMessageAcceptance(opts.replayPath);
  }

  /** Authenticated pairing room used to scope E2EE chat deep links. */
  get room(): string {
    return this.cfg.room;
  }

  private otherRole(): Role {
    return this.cfg.role === "machine" ? "phone" : "machine";
  }

  private peerIsAllowed(peerPublicKey: string): boolean {
    try { return this.opts.peerAllowed?.(peerPublicKey) ?? true; }
    catch { return false; }
  }

  connect(timeoutMs = 10_000): Promise<void> {
    if (this.isConnected) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    if (this.reconnectTimer) return Promise.reject(new Error('Relay reconnect is waiting for its retry window.'));

    this.intentionalClose = false;
    this.recipientRouting = false;
    const pending = Promise.resolve().then(() => this.opts.upgradeHeaders?.() ?? {})
      .then(headers => new Promise<void>((resolve, reject) => {
      // The room rides in the URL: the Cloudflare relay must pick a Durable
      // Object before the socket upgrades. The Node relay simply ignores it.
      const url = new URL(this.cfg.relayUrl);
      url.searchParams.set("room", this.cfg.room);
      const ws = new WebSocket(
        url.toString(),
        { headers: relayUpgradeHeaders(this.cfg, headers, this.taskDispatchListeners.size > 0 || this.taskOfferListeners.size > 0) },
      );
      this.ws = ws;
      const frames = new OutboundFrameQueue(frame => new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) { reject(new Error("relay not connected")); return; }
        ws.send(frame, error => error ? reject(error) : resolve());
      }));
      this.frames = frames;
      let opened = false, openedAt: number | undefined;
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`relay connect timeout (${this.cfg.relayUrl})`));
      }, timeoutMs);

      ws.on("open", () => {
        opened = true;
        clearTimeout(timer);
        openedAt = Date.now();
        this.socketHealth.start(ws, this.opts.pingIntervalMs ?? 20_000);
        this.admissionLease.start(ws, this.opts);
        // Announce ourselves. The envelope's cleartext (room, from) is what the
        // relay uses to register this socket; the Hello body stays encrypted.
        void this
          .send(
            { type: "hello", role: this.cfg.role, deviceName: this.cfg.deviceName, createdAt: Date.now() },
            "all",
          )
          .catch(() => {});
        resolve();
      });
      ws.on("message", (data: WebSocket.RawData) => void this.onRaw(data.toString()));
      ws.on('unexpected-response', (_request, response) => {
        this.reconnect.defer(response.headers['retry-after']);
        response.resume(); ws.terminate();
        clearTimeout(timer); reject(new Error('Relay upgrade was not accepted.'));
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        if (!opened) reject(err);
      });
      ws.on("close", (code, reason) => {
        frames.cancel();
        clearTimeout(timer);
        this.socketHealth.stop(ws);
        this.admissionLease.stop(ws);
        if (this.ws === ws) { this.reconnect.closed(openedAt, code, reason.toString()); this.ws = undefined; }
        if (!opened) reject(new Error(`relay connection closed (${this.cfg.relayUrl})`));
        this.scheduleReconnect();
      });
    })).catch(error => { this.scheduleReconnect(); throw error; });
    this.connectPromise = pending.finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private async onRaw(raw: string): Promise<void> {
    const control = safeJson(raw) as { type?: string; recipientRouting?: boolean } | null;
    if (control?.type === "relay.capabilities" && control.recipientRouting === true) {
      this.recipientRouting = true;
      return;
    }
    if (control?.type === "relay.task-job") {
      if (raw.length > 22_010_000) return;
      await consumeTaskJobOffer({ control, cfg: this.cfg, sessionKeys: this.sessionKeys,
        peerAllowed: key => this.peerIsAllowed(key), listeners: [...this.taskDispatchListeners] });
      await Promise.all([...this.taskOfferListeners].map(async listener => {
        try { await listener(control); } catch { /* A failed consumer leaves the durable job unclaimed. */ }
      }));
      return;
    }
    const opened = openRelayMessage(this.cfg, control, this.sessionKeys, key => this.peerIsAllowed(key));
    if (!opened || opened.payload.type === "task.dispatch") return;
    const { env, payload, peerPublicKey, fingerprint } = opened;
    if (this.replay.hasAccepted(fingerprint)) {
      this.ackDelivery(env.deliveryId);
      return;
    }
    if (payload.type === "session.key.grant") {
      this.sessionKeys.set(payload.sessionId, payload.key);
    }
    if (!this.replay.begin(fingerprint)) return;
    try {
      const results = await Promise.all([...this.listeners].map(async (listener) => {
        try { return (await listener(payload, peerPublicKey)) === true; } catch { return false; }
      }));
      // Hello and key grants are completely consumed by RelayClient itself.
      const accepted = payload.type === "hello" || payload.type === "session.key.grant"
        || results.some(Boolean);
      if (!accepted) return;
      this.replay.accept(fingerprint);
      this.ackDelivery(env.deliveryId);
    } finally {
      this.replay.finish(fingerprint);
    }
  }

  private ackDelivery(deliveryId: string | undefined): void {
    if (deliveryId && this.ws?.readyState === WebSocket.OPEN) {
      void this.frames?.send(JSON.stringify({ type: "relay.ack", deliveryId }), true).catch(() => {});
    }
  }

  async send(
    payload: Payload,
    to: Role | "all" = this.otherRole(),
    options: SendOptions = {},
  ): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("relay not connected");
    if (!this.frames) throw new Error("relay not connected");
    if (options.peerPublicKey) {
      await this.sendToPeer(payload, options.peerPublicKey, options);
      return;
    }
    await sendEncryptedPayload(this.frames, this.cfg, key => this.peerIsAllowed(key),
      { payload, to, options: { ...options, recipientRouting: this.recipientRouting } });
  }

  /** Add a newly issued controller without waiting for the monitor to restart. */
  addControllerPeer(peerPublicKey: string): void {
    if (this.cfg.role !== "machine" || !this.peerIsAllowed(peerPublicKey)) {
      throw new Error("controller peer is not authorized");
    }
    const peers = this.cfg.extraPeerPublicKeys ?? [];
    if (peerPublicKey !== this.cfg.peerPublicKey && !peers.includes(peerPublicKey)) {
      if (peers.length >= 16) throw new Error("controller device limit reached");
      this.cfg.extraPeerPublicKeys = [...peers, peerPublicKey];
    }
  }

  /** Keep a controller invitation visible only to the requesting phone key. */
  async sendToPeer(payload: Payload, peerPublicKey: string, options: SendOptions = {}): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("relay not connected");
    if (!peerPublicKeys(this.cfg.peerPublicKey, this.cfg.extraPeerPublicKeys).includes(peerPublicKey)
      || !this.peerIsAllowed(peerPublicKey)) throw new Error("controller peer is not authorized");
    if (!this.frames) throw new Error("relay not connected");
    await this.frames.send(sealEnvelope({ ...this.cfg, peerPublicKey }, payload, this.otherRole(), { ...options, recipientRouting: this.recipientRouting }), true);
  }

  setSessionKey(sessionId: string, key: string): void {
    this.sessionKeys.set(sessionId, key);
  }

  hasSessionKey(sessionId: string): boolean {
    return this.sessionKeys.has(sessionId);
  }

  /** Add an independent authenticated-encryption layer for one task. */
  async sendSession(
    payload: Payload,
    sessionId: string,
    to: Role | "all" = this.otherRole(),
    options: SendOptions = {},
  ): Promise<void> {
    await this.send(sealSessionPayload(payload, sessionId, this.sessionKeys.get(sessionId)), to, options);
  }

  /** Register before connect so only durable receivers advertise task-job support. */
  onTaskDispatch(listener: TaskDispatchListener): () => void {
    this.taskDispatchListeners.add(listener);
    return () => { this.taskDispatchListeners.delete(listener); };
  }

  /** Raw offers are a separate lane; consumers must verify their own scoped peer ciphertext. */
  onTaskJobOffer(listener: (control: unknown) => void | Promise<void>): () => void {
    this.taskOfferListeners.add(listener);
    return () => { this.taskOfferListeners.delete(listener); };
  }

  onMessage(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Resolve with the first payload matching `pred`, or reject on timeout. */
  waitFor<T extends Payload>(pred: (p: Payload) => p is T, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error("waitFor timeout"));
      }, timeoutMs);
      const off = this.onMessage((p) => {
        if (pred(p)) {
          clearTimeout(timer);
          off();
          resolve(p);
          return true;
        }
        return false;
      });
    });
  }

  close(): void {
    this.frames?.cancel();
    this.socketHealth.stop();
    this.admissionLease.stop();
    this.intentionalClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.ws?.close();
    this.ws = undefined;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private scheduleReconnect(): void {
    if (!this.opts.autoReconnect || this.intentionalClose || this.reconnectTimer) return;
    const delay = this.reconnect.delay();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => {
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
