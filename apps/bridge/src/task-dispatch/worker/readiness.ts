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
