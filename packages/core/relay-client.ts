/**
 * RelayClient — the shared machine/phone endpoint.
 *
 * Both the machine-side bridge and the phone talk to the relay through this.
 * It holds the E2EE keys, seals every outgoing Payload for the peer, opens
 * incoming envelopes, and exposes a small event + request/response API.
 *
 * Transport is a plain WebSocket. The relay only ever sees Envelopes (opaque
 * ciphertext bodies), so the same client works with both the Node relay and
 * the Cloudflare Durable Object deployment.
 */
import WebSocket from "ws";
import { publicKeyIdentifier } from "./ciphertext-recipient";
import { ManagedRelayLease, RelaySocketHealth } from "./socket-lifecycle";
import { OutboundFrameQueue, sendEncryptedPayload } from "./outbound-scheduler";
import { createHash } from "node:crypto";
import { Envelope, Payload, type Role } from "../protocol/schema";
import { openFromPeersWithIdentity, openWithTransferKey, peerPublicKeys, seal, sealWithTransferKey } from "./crypto";
import type { PeerConfig, RelayClientOptions, SendOptions } from "./relay-client-types";
export type { PeerConfig, RelayClientOptions, SendOptions } from "./relay-client-types";
import { loadReplayFingerprints, saveReplayFingerprints } from "./replay-store";
import { sealEnvelope } from "./relay-envelope";
export { sealEnvelope } from "./relay-envelope";

/** Return true only after this consumer has durably accepted the payload. */
type Listener = (p: Payload, peerPublicKey: string) => boolean | void | Promise<boolean | void>;

export class RelayClient {
  private ws?: WebSocket;
  private recipientRouting = false;
  private frames?: OutboundFrameQueue;
  private listeners = new Set<Listener>();
  private intentionalClose = false;
  private connectPromise?: Promise<void>;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectDelay: number;
  private readonly socketHealth = new RelaySocketHealth();
  private readonly admissionLease = new ManagedRelayLease();
  private readonly sessionKeys = new Map<string, string>();
  /**
   * Delivery ids are relay-controlled metadata, so replay protection is bound
   * to the authenticated ciphertext itself. Keep a bounded process-local set:
   * relay retries are acknowledged, but never delivered to the application
   * twice even if an attacker changes the clear-text delivery id.
   */
  private readonly seenCiphertexts = new Set<string>();
  private readonly processingCiphertexts = new Set<string>();
  private static readonly MAX_SEEN_CIPHERTEXTS = 2_048;

  constructor(
    private readonly cfg: PeerConfig,
    private readonly opts: RelayClientOptions = {},
  ) {
    this.reconnectDelay = opts.minReconnectMs ?? 1_000;
    for (const fingerprint of loadReplayFingerprints(opts.replayPath)) {
      this.seenCiphertexts.add(fingerprint);
    }
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
        { headers: { ...headers, "X-GrantTap-Recipient-Routing": "1",
          ...(this.cfg.role === "phone" ? { "X-GrantTap-Recipient-Key-Id": publicKeyIdentifier(this.cfg.myPublicKey) } : {}),
          ...(this.cfg.pushAuth ? { Authorization: `Bearer ${this.cfg.pushAuth}` } : {}) } },
      );
      this.ws = ws;
      const frames = new OutboundFrameQueue(frame => new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) { reject(new Error("relay not connected")); return; }
        ws.send(frame, error => error ? reject(error) : resolve());
      }));
      this.frames = frames;
      let opened = false;
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`relay connect timeout (${this.cfg.relayUrl})`));
      }, timeoutMs);

      ws.on("open", () => {
        opened = true;
        clearTimeout(timer);
        this.reconnectDelay = this.opts.minReconnectMs ?? 1_000;
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
      ws.on("error", (err) => {
        clearTimeout(timer);
        if (!opened) reject(err);
      });
      ws.on("close", () => {
        frames.cancel();
        clearTimeout(timer);
        this.socketHealth.stop(ws);
        this.admissionLease.stop(ws);
        if (this.ws === ws) this.ws = undefined;
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
    const parsed = Envelope.safeParse(control);
    if (!parsed.success) return;
    const env = parsed.data;
    if (env.room !== this.cfg.room) return;
    if (env.recipientKeyId && env.recipientKeyId !== publicKeyIdentifier(this.cfg.myPublicKey)) return;
    if (env.from !== this.otherRole()) return;
    if (env.to !== this.cfg.role && env.to !== "all") return;
    if (env.expiresAt != null && env.expiresAt <= Date.now()) return;
    const opened = openFromPeersWithIdentity(
      env.nonce,
      env.box,
      this.cfg.mySecretKey,
      this.cfg.peerPublicKey,
      this.cfg.extraPeerPublicKeys,
    );
    if (opened === null) return; // not for us, or tampered
    const { body, peerPublicKey } = opened;
    if (!this.peerIsAllowed(peerPublicKey)) return;
    const parsedPayload = Payload.safeParse(body);
    if (!parsedPayload.success) {
      const type = body && typeof body === "object" && "type" in body ? String((body as { type?: unknown }).type) : "";
      if (type === "pairing.join") {
        const paths = parsedPayload.error.issues.map((issue) => `${issue.path.join(".")}:${issue.code}`);
        console.error(`[granttap] dropped pairing.join (${paths.join(",") || "invalid"})`);
      }
      return;
    }
    let payload: Payload = parsedPayload.data;
    if (payload.type === "session.key.grant") {
      // A machine owns native-session keys. The paired phone may forward only
      // explicit task/project keys when the user authorizes cross-computer Mesh.
      if (this.cfg.role === "machine" && !["task", "project"].includes(payload.purpose ?? "")) return;
    } else if (payload.type === "session.sealed") {
      const key = this.sessionKeys.get(payload.sessionId);
      if (!key) return;
      const inner = openWithTransferKey(payload.nonce, payload.box, key);
      const parsedInner = Payload.safeParse(inner);
      if (
        !parsedInner.success ||
        parsedInner.data.type === "session.key.grant" ||
        parsedInner.data.type === "session.sealed"
      ) return;
      const innerSessionId = "sessionId" in parsedInner.data ? parsedInner.data.sessionId : undefined;
      if (
        !payload.sessionId.trim() ||
        typeof innerSessionId !== "string" ||
        !innerSessionId.trim() ||
        innerSessionId !== payload.sessionId
      ) return;
      payload = parsedInner.data;
    }

    const fingerprint = createHash("sha256")
      .update(env.nonce)
      .update(".")
      .update(env.box)
      .digest("base64url");
    if (this.seenCiphertexts.has(fingerprint)) {
      this.ackDelivery(env.deliveryId);
      return;
    }
    if (payload.type === "session.key.grant") {
      this.sessionKeys.set(payload.sessionId, payload.key);
    }
    if (this.processingCiphertexts.has(fingerprint)) return;
    this.processingCiphertexts.add(fingerprint);
    try {
      const results = await Promise.all([...this.listeners].map(async (listener) => {
        try { return (await listener(payload, peerPublicKey)) === true; } catch { return false; }
      }));
      // Hello and key grants are completely consumed by RelayClient itself.
      const accepted = payload.type === "hello" || payload.type === "session.key.grant"
        || results.some(Boolean);
      if (!accepted) return;
      this.seenCiphertexts.add(fingerprint);
      if (this.seenCiphertexts.size > RelayClient.MAX_SEEN_CIPHERTEXTS) {
        const oldest = this.seenCiphertexts.values().next().value;
        if (oldest) this.seenCiphertexts.delete(oldest);
      }
      saveReplayFingerprints(this.opts.replayPath, this.seenCiphertexts);
      this.ackDelivery(env.deliveryId);
    } finally {
      this.processingCiphertexts.delete(fingerprint);
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
    const key = this.sessionKeys.get(sessionId);
    if (!key) throw new Error(`no encryption key for task ${sessionId}`);
    const sealed = sealWithTransferKey(payload, key);
    await this.send({
      type: "session.sealed",
      sessionId,
      nonce: sealed.nonce,
      box: sealed.box,
      createdAt: Date.now(),
    }, to, options);
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
    const delay = this.reconnectDelay;
    const max = this.opts.maxReconnectMs ?? 15_000;
    this.reconnectDelay = Math.min(max, delay * 2);
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
