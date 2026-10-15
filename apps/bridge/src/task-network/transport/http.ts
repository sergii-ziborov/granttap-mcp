import type { Envelope } from '../../../../../packages/protocol/schema';
import type { PeerConfig } from '../../../../../packages/core/relay-client';
import type { TaskNetworkPeer } from '../../../../../packages/protocol/task-network';
import { z } from 'zod';
import { Envelope as EnvelopeSchema } from '../../../../../packages/protocol/schema';

export const PeerJobReceipt = z.object({ id: z.string(),
  state: z.enum(['queued', 'accepted', 'completed', 'failed', 'cancelled', 'expired']),
  resultEnvelope: EnvelopeSchema.optional(), resultCode: z.string().max(80).optional(),
}).passthrough();
export type PeerJobReceipt = z.infer<typeof PeerJobReceipt>;

export class TaskNetworkHttpError extends Error {
  constructor(readonly status: number) { super('The relay has not confirmed this Project network operation.'); }
}

export async function networkRequest(input: { relayUrl: string; room: string; credential: string;
  path: string; method: 'GET' | 'PUT' | 'POST' | 'DELETE'; body?: unknown; maxResponseBytes?: number },
  request: typeof fetch = fetch): Promise<unknown> {
  const url = new URL(input.path, input.relayUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
  url.searchParams.set('room', input.room); url.searchParams.set('metadata', '1');
  const response = await request(url, { method: input.method, redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${input.credential}`, accept: 'application/json',
      ...(input.body ? { 'content-type': 'application/json' } : {}) },
    ...(input.body ? { body: JSON.stringify(input.body) } : {}) });
  if (!response.ok) throw new TaskNetworkHttpError(response.status);
  const bytes: Uint8Array[] = [];
  let size = 0;
  if (!response.body) throw new TaskNetworkHttpError(502);
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > Math.min(input.maxResponseBytes ?? 40_000, 192_000)) {
      await response.body.cancel().catch(() => {}); throw new TaskNetworkHttpError(502);
    }
    bytes.push(chunk);
  }
  return JSON.parse(Buffer.concat(bytes).toString('utf8'));
}

export function peerCredential(peer: TaskNetworkPeer): string {
  return `writer:${peer.outgoing.writerId}:${peer.outgoing.secret}`;
}

export async function peerJobRequest(peer: TaskNetworkPeer, id: string, method: 'GET' | 'PUT' | 'DELETE',
  body?: unknown, request?: typeof fetch): Promise<PeerJobReceipt> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/.test(id)) throw new TaskNetworkHttpError(400);
  const raw = await networkRequest({ ...peer.outgoing, credential: peerCredential(peer),
    path: `/task-jobs/${id}`, method, body }, request);
  const receipt = z.object({ job: PeerJobReceipt }).parse(raw).job;
  if (receipt.id !== id) throw new TaskNetworkHttpError(502);
  return receipt;
}

export async function receiverJobRequest(config: PeerConfig, id: string, action: 'claim' | 'finish',
  proof: { token: string; recipientKeyId: string; claimId: string; state?: 'completed' | 'failed';
    resultCode?: string; resultEnvelope?: Envelope }, request?: typeof fetch): Promise<PeerJobReceipt> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/.test(id)) throw new TaskNetworkHttpError(400);
  const raw = await networkRequest({ ...config, credential: config.pushAuth ?? '',
    path: `/task-jobs/${id}/${action}`, method: 'POST', body: proof }, request);
  return z.object({ job: PeerJobReceipt }).parse(raw).job;
}
