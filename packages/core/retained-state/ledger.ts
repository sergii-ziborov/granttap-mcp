import { createHash } from 'node:crypto';
import type { Payload } from '../../protocol/schema';
import { retainedPayloadOptions } from './index';

/** An unchanged state is still handed to the relay again after this long, in case its copy was lost. */
export const RETAINED_REFRESH_MS = 5 * 60_000;
/** A Mesh snapshot is published plain and then enriched; both are recognised as already sent. */
const RECENT_COPIES = 3;

/**
 * The read state one relay connection has already handed over.
 *
 * The relay keeps the latest copy of each state for every phone and replays it
 * when a phone joins, so giving it the same copy again only spends upload. The
 * monitor republished every Mesh snapshot and every open chat each time a phone
 * asked for a fresh catalog, several times a second: about 8 MB/s of identical
 * frames, with the computer's heartbeat and its replies queued behind them.
 */
export class RetainedStateLedger {
  private readonly sent = new Map<string, { digests: string[]; at: number }>();
  private readonly digests = new WeakMap<object, string>();

  constructor(private readonly now: () => number = Date.now) {}

  private slot(payload: Payload, recipient: string): { key: string; digest: string } | undefined {
    const { stateKey } = retainedPayloadOptions(payload);
    if (!stateKey) return undefined;
    let digest = this.digests.get(payload);
    if (!digest) {
      digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      this.digests.set(payload, digest);
    }
    return { key: `${stateKey}\0${recipient}`, digest };
  }

  /** True when this exact state went to the relay on this connection, recently. */
  unchanged(payload: Payload, recipient: string): boolean {
    const slot = this.slot(payload, recipient);
    const entry = slot ? this.sent.get(slot.key) : undefined;
    return entry !== undefined && this.now() - entry.at < RETAINED_REFRESH_MS
      && entry.digests.includes(slot!.digest);
  }

  /** Note a state the relay now holds. */
  remember(payload: Payload, recipient: string): void {
    const slot = this.slot(payload, recipient);
    if (!slot) return;
    const previous = this.sent.get(slot.key)?.digests ?? [];
    this.sent.set(slot.key, { digests: [slot.digest, ...previous.filter((item) => item !== slot.digest)]
      .slice(0, RECENT_COPIES), at: this.now() });
  }

  /** A new connection or a new phone starts with nothing handed over. */
  forget(): void {
    this.sent.clear();
  }
}
