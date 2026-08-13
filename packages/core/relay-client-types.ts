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
  /** Relay-only random credential for push-token registration; never an E2EE key. */
  pushAuth?: string;
};

/** Persistent processes reconnect in the background; one-shot hooks leave this off. */
export type RelayClientOptions = {
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
