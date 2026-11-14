import { createHash } from 'node:crypto';
import type { Payload } from '../../protocol/schema';
import { retainedPayloadOptions } from './index';

/** A Mesh snapshot whose only news is account usage waits this long, so usage reaches the phone a few times an hour. */
export const RETAINED_REFRESH_MS = 5 * 60_000;
/** A Mesh snapshot is published plain and then enriched; both are recognised as already sent. */
const RECENT_COPIES = 3;
/** Fields that say when something was looked at, not what it is. */
const OBSERVATION_KEYS = new Set(['generatedAt', 'observedAt']);

type Model = { provider: string; modelId: string; source?: string };
const isModel = (value: unknown): value is Model => !!value && typeof value === 'object'
  && typeof (value as Model).provider === 'string' && typeof (value as Model).modelId === 'string';
const modelOrder = (model: Model) => `${model.provider}\0${model.modelId}\0${model.source ?? ''}`;

/**
 * What a Mesh snapshot says, without when it was looked at. Every project's
 * snapshot carries this computer's model catalog and account usage, observed
 * anew and in no fixed order on each build. Compared as built, all 92 snapshots
 * on the owner's Mac looked new on every refresh and went to all 17 phones again.
 * Account usage is real news, but the same for every project: it is compared
 * separately and sent at most every five minutes.
 */
export function comparableMeshState(value: unknown, withUsage = false): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => comparableMeshState(item, withUsage));
    return items.length > 1 && items.every(isModel)
      ? [...items].sort((left, right) => modelOrder(left).localeCompare(modelOrder(right))) : items;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !OBSERVATION_KEYS.has(key) && (withUsage || key !== 'accountUsage'))
    .map(([key, item]) => [key, comparableMeshState(item, withUsage)]));
}

/**
 * The read state one relay connection has already handed over.
 *
 * The relay keeps the latest copy of each state for every phone and replays it
 * when a phone joins, so giving it the same copy again only spends upload. The
 * monitor republished every Mesh snapshot and every chat head on each catalog
 * refresh, sealed once for each paired phone: on the owner's Mac 92 projects,
 * 17 phones and several megabytes a second, with the computer's heartbeat and
 * its replies queued behind them.
 */
export class RetainedStateLedger {
  private readonly sent = new Map<string, { same: string[]; usage: string[]; at: number }>();
  private readonly digests = new WeakMap<object, { same: string; usage: string }>();

  constructor(private readonly now: () => number = Date.now) {}

  private slot(payload: Payload, recipient: string) {
    const { stateKey } = retainedPayloadOptions(payload);
    if (!stateKey) return undefined;
    let digest = this.digests.get(payload);
    if (!digest) {
      const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
      digest = payload.type === 'mesh.snapshot'
        ? { same: hash(comparableMeshState(payload)), usage: hash(comparableMeshState(payload, true)) }
        : { same: hash(payload), usage: '' };
      if (!digest.usage) digest.usage = digest.same;
      this.digests.set(payload, digest);
    }
    return { key: `${stateKey}\0${recipient}`, ...digest };
  }

  /**
   * True when the relay already holds this state from this connection. A copy
   * whose only news is account usage counts as held for five minutes.
   */
  unchanged(payload: Payload, recipient: string): boolean {
    const slot = this.slot(payload, recipient);
    const entry = slot ? this.sent.get(slot.key) : undefined;
    if (!slot || !entry || !entry.same.includes(slot.same)) return false;
    return this.now() - entry.at < RETAINED_REFRESH_MS || entry.usage.includes(slot.usage);
  }

  /** Note a state the relay now holds. */
  remember(payload: Payload, recipient: string): void {
    const slot = this.slot(payload, recipient);
    if (!slot) return;
    const entry = this.sent.get(slot.key);
    const keep = (list: string[] | undefined, digest: string) => [digest, ...(list ?? []).filter((item) => item !== digest)]
      .slice(0, RECENT_COPIES);
    this.sent.set(slot.key, { same: keep(entry?.same, slot.same), usage: keep(entry?.usage, slot.usage), at: this.now() });
  }

  /** A new connection or a new phone starts with nothing handed over. */
  forget(): void {
    this.sent.clear();
  }
}
