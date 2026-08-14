import { randomUUID } from "node:crypto";
import { Envelope, PROTOCOL_VERSION, type Payload, type Role } from "../protocol/schema";
import { seal } from "./crypto";
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
  const envelope: Envelope = {
    v: PROTOCOL_VERSION,
    room: cfg.room,
    from: cfg.role,
    to,
    senderId: cfg.senderId,
    deliveryId: options.reliable === false
      ? undefined
      : options.deliveryId ?? randomUUID(),
    wake: options.wake,
    expiresAt: options.ttlMs == null ? undefined : Date.now() + options.ttlMs,
    nonce,
    box,
  };
  return JSON.stringify(envelope);
}
