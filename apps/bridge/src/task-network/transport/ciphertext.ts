import { createHash } from 'node:crypto';
import type { PeerConfig } from '../../../../../packages/core/relay-client';
import { open, seal } from '../../../../../packages/core/crypto';
import { publicKeyIdentifier } from '../../../../../packages/core/ciphertext-recipient';
import { Envelope } from '../../../../../packages/protocol/schema';
import { PeerTaskResult, type PeerTaskDispatch, type TaskNetworkPeer } from '../../../../../packages/protocol/task-network';

export function networkEnvelope(config: PeerConfig, input: {
  publicKey: string; room: string; body: unknown; id: string; expiresAt: number;
}): Envelope {
  return { v: 1, room: input.room, from: 'machine', to: 'machine', senderId: config.senderId,
    deliveryId: input.id, expiresAt: input.expiresAt, recipientKeyId: publicKeyIdentifier(input.publicKey),
    ...seal(input.body, input.publicKey, config.mySecretKey) };
}

export function peerJobBody(config: PeerConfig, peer: TaskNetworkPeer, job: PeerTaskDispatch) {
  const envelope = networkEnvelope(config, { publicKey: peer.publicKey, room: peer.outgoing.room,
    body: job, id: job.jobId, expiresAt: job.expiresAt });
  return { notBefore: job.notBefore, expiresAt: job.expiresAt,
    acceptanceHash: createHash('sha256').update(job.token).digest('hex'), envelope };
}

export function openPeerResult(raw: unknown, config: PeerConfig, peer: TaskNetworkPeer,
  expected: { jobId: string; projectId: string; taskId: string; retainedUntil?: number }, now = Date.now()): PeerTaskResult | undefined {
  const parsed = Envelope.safeParse(raw);
  if (!parsed.success) return undefined;
  const env = parsed.data;
  // A retained result is evidence of past work, never permission to execute it.
  const deadline = expected.retainedUntil ?? env.expiresAt;
  if (env.room !== peer.outgoing.room || env.from !== 'machine' || env.to !== 'machine'
    || env.deliveryId !== expected.jobId || env.expiresAt == null || deadline == null || deadline <= now
    || env.recipientKeyId !== publicKeyIdentifier(config.myPublicKey)) return undefined;
  const body = PeerTaskResult.safeParse(open(env.nonce, env.box, peer.publicKey, config.mySecretKey));
  return body.success && body.data.jobId === expected.jobId && body.data.projectId === expected.projectId
    && body.data.taskId === expected.taskId ? body.data : undefined;
}
