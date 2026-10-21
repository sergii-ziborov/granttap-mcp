import type { CapabilityExecutionSummary, CapabilityUsageTotal, RemoteCapabilityUsageEvent } from '../../../../../../../packages/protocol/schema';
import { CAPABILITY_TOTAL_WINDOWS, createCapabilityTotals } from '../../../support/capability-totals';
import { createExecutionSummaries } from '../../../telemetry/execution-summaries';
import { toRemoteCapabilityUsageEvent, type CapabilityObservation } from '../../../telemetry';

type RecordedClaudeUsage = { summaries: CapabilityExecutionSummary[]; totals: CapabilityUsageTotal[]; nextExpiry: number };
const recorded = new WeakMap<CapabilityObservation[], RecordedClaudeUsage>();

/** Cached aggregates outlive the bounded details, without retaining inputs or result bodies. */
export function recordedClaudeUsage(observations: CapabilityObservation[]): RecordedClaudeUsage | undefined {
  return recorded.get(observations);
}

export function recordedClaudeUsageIsCurrent(observations: CapabilityObservation[]): boolean {
  return Date.now() < (recorded.get(observations)?.nextExpiry ?? Infinity);
}

export function createClaudeUsageRecorder() {
  const events = new Map<string, RemoteCapabilityUsageEvent>();
  const cutoff = Date.now() - 30 * 86400_000;
  return {
    remember(observation: CapabilityObservation) {
      if (!observation.mcpServer && !observation.skill) return;
      const converted = toRemoteCapabilityUsageEvent(observation);
      if (!converted || converted.createdAt < cutoff) return;
      const event = { ...converted, agent: 'claude' as const };
      events.delete(event.sourceId);
      events.set(event.sourceId, event);
      while (events.size > 20000) events.delete(events.keys().next().value!);
    },
    finish(observations: CapabilityObservation[]) {
      const summaries = createExecutionSummaries(), totals = createCapabilityTotals();
      const now = Date.now();
      let nextExpiry = Infinity;
      for (const event of events.values()) {
        summaries.add(event, 'transcript');
        totals.add(event);
        for (const hours of CAPABILITY_TOTAL_WINDOWS) {
          const expires = event.createdAt + hours * 3600_000;
          if (expires > now) nextExpiry = Math.min(nextExpiry, expires);
        }
      }
      recorded.set(observations, { summaries: summaries.rows(), totals: totals.rows(), nextExpiry });
      events.clear();
    },
  };
}

/** Child source IDs belong to their own transcript; the Project uses the parent execution. */
export function mergeRecordedClaudeUsage(parent: CapabilityObservation[], child: CapabilityObservation[]): void {
  const summaries = createExecutionSummaries(), totals = createCapabilityTotals();
  let nextExpiry = Infinity;
  for (const observations of [parent, child]) {
    const usage = recorded.get(observations);
    for (const summary of usage?.summaries ?? []) summaries.merge(summary);
    for (const total of usage?.totals ?? []) totals.merge(total);
    nextExpiry = Math.min(nextExpiry, usage?.nextExpiry ?? Infinity);
  }
  recorded.set(parent, { summaries: summaries.rows(), totals: totals.rows(), nextExpiry });
}
