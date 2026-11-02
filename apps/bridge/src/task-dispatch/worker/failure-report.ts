import { TaskJobHttpError } from '../../../../../packages/core/task-job-http';

const NETWORK = new Set(['UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET', 'EPIPE',
  'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN']);
/** The worker retries every two seconds; a blip shorter than this is not news. */
export const NETWORK_GRACE_MS = 30_000;
/** A quiet gap this long between failures means the previous outage ended. */
const OUTAGE_GAP_MS = 10_000;

/** A dropped connection, a timeout or a relay 5xx heals on the next pass; storage errors do not. */
export function transientQueueFailure(error: unknown): boolean {
  if (error instanceof TaskJobHttpError) return error.status >= 500;
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  return NETWORK.has(String((error.cause as NodeJS.ErrnoException | undefined)?.code));
}

/** Storage and relay errors name a status or a path, never a prompt. */
export function queueFailureReporter(write = (line: string) => { process.stderr.write(line); }, now = Date.now) {
  let reportedAt = 0, failingSince = 0, failedAt = 0;
  return {
    report(error: unknown) {
      const transient = transientQueueFailure(error);
      if (transient) {
        if (now() - failedAt > OUTAGE_GAP_MS) failingSince = now();
        failedAt = now();
        if (now() - failingSince < NETWORK_GRACE_MS) return;
      }
      if (now() - reportedAt < 60_000) return;
      reportedAt = now();
      // A failed fetch keeps its reason (DNS, TLS, a closed socket) in `cause`.
      const reason = error instanceof Error && error.cause instanceof Error
        ? ` [${(error.cause as NodeJS.ErrnoException).code ?? error.cause.name}]` : '';
      const cause = error instanceof Error ? `${error.name}: ${error.message}${reason}`.slice(0, 200) : 'unknown';
      write(transient
        ? `[monitor] Relay task queue unreachable for ${Math.round((now() - failingSince) / 1000)} s (${cause}); `
          + 'retrying. No prompt was replayed.\n'
        : `[monitor] Durable task queue needs storage or relay recovery (${cause}). No prompt was replayed.\n`);
    },
  };
}
