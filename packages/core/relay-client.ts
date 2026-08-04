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
import { createHash, randomUUID } from "node:crypto";
import { Envelope, PROTOCOL_VERSION, Payload, type Role } from "../protocol/schema";
import { open, openWithTransferKey, seal, sealWithTransferKey } from "./crypto";

export type PeerConfig = {
  relayUrl: string;
  room: string;
  role: Role;
  deviceName: string;
  senderId: string;
  myPublicKey: string;
  mySecretKey: string;
  peerPublicKey: string;
  /** Relay-only random credential for push-token registration; never an E2EE key. */
  pushAuth?: string;
};

/** Return true only after this consumer has durably accepted the payload. */
type Listener = (p: Payload) => boolean | void | Promise<boolean | void>;

export type RelayClientOptions = {
  /** Persistent processes reconnect in the background; one-shot hooks leave this off. */
  autoReconnect?: boolean;
  minReconnectMs?: number;
  maxReconnectMs?: number;
};

export type SendOptions = {
  /** Delivery lifetime for relay hold queues. Omit only for non-expiring hello packets. */
  ttlMs?: number;
  deliveryId?: string;
  /** Ask the relay for a content-neutral APNs wake. Never carries a message kind. */
  wake?: boolean;
};

export class RelayClient {
  private ws?: WebSocket;
  private listeners = new Set<Listener>();
  private intentionalClose = false;
  private connectPromise?: Promise<void>;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectDelay: number;
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
  }

  private otherRole(): Role {
    return this.cfg.role === "machine" ? "phone" : "machine";
  }

  connect(timeoutMs = 10_000): Promise<void> {
    if (this.isConnected) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.intentionalClose = false;
    const pending = new Promise<void>((resolve, reject) => {
      // The room rides in the URL: the Cloudflare relay must pick a Durable
      // Object before the socket upgrades. The Node relay simply ignores it.
      const url = new URL(this.cfg.relayUrl);
      url.searchParams.set("room", this.cfg.room);
      const ws = new WebSocket(
        url.toString(),
        this.cfg.pushAuth
          ? { headers: { Authorization: `Bearer ${this.cfg.pushAuth}` } }
          : undefined,
      );
      this.ws = ws;
      let opened = false;
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`relay connect timeout (${this.cfg.relayUrl})`));
      }, timeoutMs);

      ws.on("open", () => {
        opened = true;
        clearTimeout(timer);
        this.reconnectDelay = this.opts.minReconnectMs ?? 1_000;
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
        clearTimeout(timer);
        if (this.ws === ws) this.ws = undefined;
        if (!opened) reject(new Error(`relay connection closed (${this.cfg.relayUrl})`));
        this.scheduleReconnect();
      });
    });
    this.connectPromise = pending.finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private async onRaw(raw: string): Promise<void> {
    const parsed = Envelope.safeParse(safeJson(raw));
    if (!parsed.success) return;
    const env = parsed.data;
    if (env.room !== this.cfg.room) return;
    if (env.from !== this.otherRole()) return;
    if (env.to !== this.cfg.role && env.to !== "all") return;
    if (env.expiresAt != null && env.expiresAt <= Date.now()) return;
    const body = open(env.nonce, env.box, this.cfg.peerPublicKey, this.cfg.mySecretKey);
    if (body === null) return; // not for us, or tampered
    const parsedPayload = Payload.safeParse(body);
    if (!parsedPayload.success) return;
    let payload: Payload = parsedPayload.data;
    if (payload.type === "session.key.grant") {
      // Only the machine may attach a task and grant its independent key.
      if (this.cfg.role !== "phone") return;
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
      if (typeof innerSessionId === "string" && innerSessionId !== payload.sessionId) return;
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
        try { return (await listener(payload)) === true; } catch { return false; }
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
      this.ackDelivery(env.deliveryId);
    } finally {
      this.processingCiphertexts.delete(fingerprint);
    }
  }

  private ackDelivery(deliveryId: string | undefined): void {
    if (deliveryId && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "relay.ack", deliveryId }));
    }
  }

  async send(
    payload: Payload,
    to: Role | "all" = this.otherRole(),
    options: SendOptions = {},
  ): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("relay not connected");
    const { nonce, box } = seal(payload, this.cfg.peerPublicKey, this.cfg.mySecretKey);
    const env: Envelope = {
      v: PROTOCOL_VERSION,
      room: this.cfg.room,
      from: this.cfg.role,
      to,
      senderId: this.cfg.senderId,
      deliveryId: options.deliveryId ?? randomUUID(),
      wake: options.wake,
      expiresAt: options.ttlMs == null ? undefined : Date.now() + options.ttlMs,
      nonce,
      box,
    };
    ws.send(JSON.stringify(env));
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
