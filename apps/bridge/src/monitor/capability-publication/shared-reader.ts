import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { CapabilityUsageStatus, SessionInfo } from '../../../../../packages/protocol/schema';

type Observation = { until: number; value: Promise<CapabilityUsageStatus> };

/** Coalesce identical machine-side reads; room scoping still happens for each recipient. */
export function createSharedCapabilityReader(scan: (sessions: SessionInfo[]) => Promise<CapabilityUsageStatus>,
  now: () => number = () => performance.now()) {
  const cache = new Map<string, Observation>();
  return (sessions: SessionInfo[]): Promise<CapabilityUsageStatus> => {
    const snapshot = JSON.stringify(sessions);
    const key = createHash('sha256').update(snapshot).digest('hex');
    const previous = cache.get(key);
    if (previous && now() < previous.until) return previous.value;
    cache.delete(key);
    if (cache.size >= 16) cache.delete(cache.keys().next().value!);
    const entry: Observation = { until: Infinity,
      value: Promise.resolve().then(() => scan(JSON.parse(snapshot) as SessionInfo[])) };
    entry.value = entry.value.then(value => {
      entry.until = now() + 1_000;
      return value;
    }, error => {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    });
    cache.set(key, entry);
    return entry.value;
  };
}
