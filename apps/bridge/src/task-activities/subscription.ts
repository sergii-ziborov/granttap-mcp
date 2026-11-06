import { z } from 'zod';
import type { PeerConfig } from '../../../../packages/core/relay-client';
import { openFromPeersWithIdentity } from '../../../../packages/core/crypto';

const subscription = z.object({version: z.literal(1), kind: z.literal('task.activity.subscription'),
  room: z.string().min(1).max(180), activityId: z.string().regex(/^[A-Za-z0-9_-]{1,180}$/),
  keyId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), key: z.string().min(43).max(44),
  expiresAt: z.number().int().positive(), previews: z.boolean()}).strict();
const route = z.object({activityId: z.string(), expiresAt: z.number(),
  nonce: z.string().length(32), box: z.string().min(24).max(2048)}).strict();
export type ActivitySubscription = z.infer<typeof subscription> & {peerPublicKey: string};

export function activitySubscription(config: PeerConfig, input: unknown,
  peerAllowed: (key: string) => boolean, now: number): ActivitySubscription | null {
  const record = route.safeParse(input);
  if (!record.success) return null;
  const opened = openFromPeersWithIdentity(record.data.nonce, record.data.box, config.mySecretKey,
    config.peerPublicKey, config.extraPeerPublicKeys);
  if (!opened || !peerAllowed(opened.peerPublicKey)) return null;
  const parsed = subscription.safeParse(opened.body);
  if (!parsed.success) return null;
  const value = parsed.data;
  if (value.room !== config.room || value.activityId !== record.data.activityId
    || value.expiresAt !== record.data.expiresAt || value.expiresAt <= now
    || value.expiresAt > now + 8 * 60 * 60_000 || Buffer.from(value.key, 'base64url').length !== 32) return null;
  return {...value, peerPublicKey: opened.peerPublicKey};
}
