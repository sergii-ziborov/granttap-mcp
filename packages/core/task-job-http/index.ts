import { z } from 'zod';
import type { PeerConfig } from '../relay-client-types';

export const TaskJobReceipt = z.object({ id: z.string(),
  state: z.enum(['queued', 'accepted', 'completed', 'failed', 'cancelled', 'expired']),
  notBefore: z.number().int(), expiresAt: z.number().int(), resultCode: z.string().max(80).optional() });
export type TaskJobReceipt = z.infer<typeof TaskJobReceipt>;
export class TaskJobHttpError extends Error {
  constructor(readonly status: number) { super('The relay did not confirm the queued task operation.'); }
}

/** Only a bounded receipt is returned; prompt and photo ciphertext are never echoed into status polling. */
export async function requestTaskJob(config: PeerConfig, input: {
  id: string; method: 'GET' | 'PUT' | 'POST' | 'DELETE'; action?: 'claim' | 'finish'; body?: unknown;
}, request: typeof fetch = fetch): Promise<TaskJobReceipt | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/.test(input.id)) throw new TaskJobHttpError(400);
  const url = new URL(`/task-jobs/${input.id}${input.action ? '/' + input.action : ''}`, config.relayUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
  url.searchParams.set('room', config.room); url.searchParams.set('metadata', '1');
  const response = await request(url, { method: input.method, redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${config.pushAuth ?? ''}`, accept: 'application/json',
      ...(input.body ? { 'content-type': 'application/json' } : {}) },
    body: input.body ? JSON.stringify(input.body) : undefined });
  if ([404, 409].includes(response.status)) return null;
  if (!response.ok) throw new TaskJobHttpError(response.status);
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 20_000) throw new TaskJobHttpError(502);
  const receipt = z.object({ job: TaskJobReceipt }).parse(JSON.parse(raw)).job;
  if (receipt.id !== input.id) throw new TaskJobHttpError(502);
  return receipt;
}
