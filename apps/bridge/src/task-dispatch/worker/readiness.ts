import type { SessionInfo, TaskDispatch } from '../../../../../packages/protocol/schema';

/** Manual release bypasses busy state only. Pause, native admission and policy still win. */
export function taskDispatchReady(job: TaskDispatch, observation: {
  session?: SessionInfo; generatedAt?: number; inFlight: boolean; paused: boolean;
}, now = Date.now()): boolean {
  if (observation.inFlight || observation.paused) return false;
  if (!job.sessionId || job.deliveryMode === 'immediate') return true;
  const age = now - (observation.generatedAt ?? 0);
  if (age < 0 || age > 60_000 || observation.generatedAt === undefined) return false;
  // A fresh catalog missing the chat proceeds to normal delivery validation,
  // which returns a definite rejection rather than keeping a lost task forever.
  return !observation.session || observation.session.state === 'idle';
}

/** The catalog loop runs every 30 s; a waiting queued message should not. */
export const QUEUED_CATALOG_REFRESH_MS = 10_000;

/** One rate-limited catalog refresh lets a queued job see its chat go idle sooner. */
export function queuedCatalogRefreshDue(job: TaskDispatch, observation: {
  generatedAt?: number; inFlight: boolean; paused: boolean;
}, lastRefreshAt: number, now = Date.now()): boolean {
  if (!job.sessionId || job.deliveryMode === 'immediate' || observation.inFlight || observation.paused) return false;
  return now - (observation.generatedAt ?? 0) >= QUEUED_CATALOG_REFRESH_MS
    && now - lastRefreshAt >= QUEUED_CATALOG_REFRESH_MS;
}
