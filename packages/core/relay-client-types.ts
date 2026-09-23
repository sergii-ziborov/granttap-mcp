import type { Role } from "../protocol/schema";

/** Public pairing material for one encrypted machine/phone endpoint. */
export type PeerConfig = {
  relayUrl: string;
  room: string;
  role: Role;
  deviceName: string;
  senderId: string;
  myPublicKey: string;
  mySecretKey: string;
  peerPublicKey: string;
  /** Additional approved peer keys in this room. Each peer keeps its own secret key. */
  extraPeerPublicKeys?: string[];
  /** Relay-only random credential for push-token registration; never an E2EE key. */
  pushAuth?: string;
};

/** Persistent processes reconnect in the background; one-shot hooks leave this off. */
export type RelayClientOptions = {
  autoReconnect?: boolean;
  minReconnectMs?: number;
  maxReconnectMs?: number;
  /**
   * How often to ask the relay to prove the socket is still alive, and how long
   * to wait for the answer. A laptop that changes network leaves its socket
   * half-open: no close arrives, `readyState` stays OPEN, and nothing schedules
   * a reconnect — the computer believes it is online while the phone has
   * already been told it is not.
   */
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  /** Durable ciphertext fingerprints so a restart cannot replay a consumed box. */
  replayPath?: string;
  /** Refuse a revoked or expired controller before handling or sending payloads. */
  peerAllowed?: (peerPublicKey: string) => boolean;
};

export type SendOptions = {
  /** Delivery lifetime for relay hold queues. Omit only for non-expiring hello packets. */
  ttlMs?: number;
  deliveryId?: string;
  /**
   * Periodic snapshots are replaceable and must not enter the durable mailbox.
   *
   * Without this, every catalog tick was queued until the phone acknowledged
   * it, so a backlog of superseded snapshots delayed the current one and the
   * computer looked offline while it was busily publishing.
   */
  reliable?: boolean;
  /** Ask the relay for a content-neutral APNs wake. Never carries a message kind. */
  wake?: boolean;
};
