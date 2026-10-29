import { EngineRemoteError, type EngineOperation, type EngineResult } from '../../protocol/engine-protocol';
import type { InvocationEvent } from '../../protocol/engine-invocation-protocol';
import type { InvocationLogCursor } from '../log-reader';
import type { InvocationParseState } from '../parse';

export type InvocationBatch = {
  events: InvocationEvent[];
  nextEvent: number;
  next: InvocationLogCursor;
  parse?: InvocationParseState;
};

const MAX_PENDING_SOURCES = 32;
const CAPACITY_RETRY_MS = 5 * 60_000;
type Client = { request(operation: EngineOperation): Promise<EngineResult> };

/** Retain uncertain evidence, not a replay of every successfully committed event. */
export class InvocationDelivery {
  private pending = new Map<string, InvocationBatch>();
  private retryAt = 0;
  private failures = 0;

  constructor(private client: Client, private now: () => number = Date.now) {}

  ready(): boolean { return this.now() >= this.retryAt; }

  async advance(key: string, prepare: () => InvocationBatch) {
    if (!this.pending.has(key) && this.pending.size >= MAX_PENDING_SOURCES) return undefined;
    let batch = this.pending.get(key);
    if (!batch) {
      try { batch = prepare(); }
      catch { return undefined; } // An unavailable source is not a committed cursor.
    }
    let accepted = 0;
    for (; batch.nextEvent < batch.events.length; batch.nextEvent++) {
      try {
        await this.client.request({ operation: 'invocation.observe', input: batch.events[batch.nextEvent]! });
        accepted++;
      } catch (error) {
        this.pending.set(key, batch);
        this.failures++;
        const capacity = error instanceof EngineRemoteError && (error.code === 'INVOCATION_CAPACITY'
          || (error.code === 'INVOCATION_STATE_WRITE_FAILED' && /size limit/i.test(error.message)));
        this.retryAt = this.now() + (capacity ? CAPACITY_RETRY_MS
          : Math.min(60_000, 1_000 * 2 ** Math.min(this.failures - 1, 6)));
        return { batch, accepted, complete: false };
      }
    }
    this.pending.delete(key);
    if (accepted) { this.failures = 0; this.retryAt = 0; }
    return { batch, accepted, complete: true };
  }
}
