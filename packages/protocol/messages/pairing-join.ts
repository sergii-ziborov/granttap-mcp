import { z } from "zod";

const PairingKey = z.string().min(40).max(64);
const RoomId = z.string().regex(/^[a-f0-9]{16,64}$/);

/** Phone half carried so the new computer can re-issue a QR for this room. */
export const PairingJoinPhone = z.object({
  relayUrl: z.string().min(8).max(512),
  room: RoomId,
  role: z.literal("phone"),
  deviceName: z.string().min(1).max(180),
  senderId: z.string().min(1).max(180),
  myPublicKey: PairingKey,
  mySecretKey: PairingKey,
  peerPublicKey: PairingKey,
  pushAuth: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  extraPeerPublicKeys: z.array(PairingKey).max(16).optional(),
}).strict();
export type PairingJoinPhone = z.infer<typeof PairingJoinPhone>;

/**
 * A phone already in a room scanned a new computer. That computer keeps its
 * own machine keys and moves into this room. Two rooms are not created.
 */
export const PairingJoin = z.object({
  type: z.literal("pairing.join"),
  room: RoomId,
  relayUrl: z.string().min(8).max(512),
  phonePublicKey: PairingKey,
  phoneCfg: PairingJoinPhone,
  createdAt: z.number().nonnegative(),
}).strict();
export type PairingJoin = z.infer<typeof PairingJoin>;
