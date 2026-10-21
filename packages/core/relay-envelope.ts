import { randomUUID } from "node:crypto";
import { Envelope, PROTOCOL_VERSION, type Payload, type Role } from "../protocol/schema";
import { publicKeyIdentifier } from "./ciphertext-recipient";
import { seal, sealWithTransferKey } from "./crypto";
import type { PeerConfig, SendOptions } from "./relay-client-types";

/**
 * Build one encrypted envelope.
 *
 * A `deliveryId` is what makes the relay hold a copy until the peer confirms
 * it, so `reliable: false` deliberately omits it: a snapshot that the next tick
 * replaces must never outlive its own usefulness inside the mailbox. Queuing
 * every periodic catalog was why a superseded backlog delayed the current one
 * and a busy computer read as offline.
 */
export function sealEnvelope(
  cfg: PeerConfig,
  payload: Payload,
  to: Role | "all",
  options: SendOptions = {},
): string {
  const { nonce, box } = seal(payload, cfg.peerPublicKey, cfg.mySecretKey);
  const retained = cfg.role === "machine" && to === "phone" && options.retainedState && options.stateKey;
  const envelope: Envelope = {
    ...(retained ? { stateKey: options.stateKey, stateRevision: options.stateRevision,
      statePriority: options.statePriority } : {}),
    v: PROTOCOL_VERSION,
    room: cfg.room,
    from: cfg.role,
    to,
    senderId: cfg.senderId,
    recipientKeyId: options.recipientRouting || retained ? publicKeyIdentifier(cfg.peerPublicKey) : undefined,
    deliveryId: retained || options.reliable === false
      ? undefined
      : options.deliveryId ?? randomUUID(),
    wake: options.wake,
    expiresAt: retained ? Date.now() + 7 * 86400000
      : options.ttlMs == null ? undefined : Date.now() + options.ttlMs,
    nonce,
    box,
  };
  return JSON.stringify(envelope);
}

/** Apply the independent task encryption layer before transport encryption. */
export function sealSessionPayload(payload: Payload, sessionId: string, key: string | undefined): Payload {
  if (!key) throw new Error(`no encryption key for task ${sessionId}`);
  const { nonce, box } = sealWithTransferKey(payload, key);
  return { type: 'session.sealed', sessionId, nonce, box, createdAt: Date.now() };
}
