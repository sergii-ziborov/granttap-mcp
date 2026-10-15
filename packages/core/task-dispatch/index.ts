import { z } from 'zod';
import { Envelope, type TaskDispatch } from '../../protocol/schema';
import { publicKeyIdentifier } from '../ciphertext-recipient';
import { openRelayMessage } from '../relay-inbound';
import type { PeerConfig } from '../relay-client-types';

export type TaskDispatchListener = (job: TaskDispatch, peerPublicKey: string) => void | Promise<void>;
const Offer = z.object({ type: z.literal('relay.task-job'), job: z.object({
  id: z.string(), state: z.literal('queued'), notBefore: z.number().int(),
  expiresAt: z.number().int(), envelope: Envelope,
}) });

/** The relay's clear metadata can never override the controller's encrypted intent. */
export async function consumeTaskJobOffer(input: {
  control: unknown; cfg: PeerConfig; sessionKeys: Map<string, string>;
  peerAllowed: (key: string) => boolean; listeners: TaskDispatchListener[];
}): Promise<void> {
  if (input.cfg.role !== 'machine' || !input.listeners.length) return;
  const offered = Offer.safeParse(input.control);
  if (!offered.success) return;
  const { job } = offered.data;
  if (job.envelope.deliveryId !== job.id || job.envelope.expiresAt !== job.expiresAt
    || job.envelope.recipientKeyId !== publicKeyIdentifier(input.cfg.myPublicKey)) return;
  const localKey = input.cfg.myPublicKey;
  const offerConfig = { ...input.cfg,
    extraPeerPublicKeys: [...(input.cfg.extraPeerPublicKeys ?? []), localKey] };
  const opened = openRelayMessage(offerConfig, job.envelope, input.sessionKeys,
    key => key === localKey || input.peerAllowed(key));
  if (!opened || opened.payload.type !== 'task.dispatch') return;
  const payload = opened.payload;
  if ((opened.peerPublicKey === localKey) !== (payload.origin === 'computer')) return;
  if (payload.jobId !== job.id || payload.notBefore !== job.notBefore
    || payload.expiresAt !== job.expiresAt || payload.notBefore > Date.now()) return;
  await Promise.all(input.listeners.map(async listener => {
    try { await listener(payload, opened.peerPublicKey); } catch { /* durable receipt remains queued */ }
  }));
}
