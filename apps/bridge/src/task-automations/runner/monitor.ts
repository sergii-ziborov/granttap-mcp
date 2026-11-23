import type { RelayClient } from '../../../../../packages/core/relay-client';
import type { UserMessage } from '../../../../../packages/protocol/schema';
import { isSessionPaused } from '../../config';
import { limitContinuationFor } from '../../limit-continuation';
import { handleUserMessage } from '../../monitor/handlers/user-message';
import { cachedNativeAccountUsage } from '../../provider-account-status';
import { isDeliveryInFlight } from '../../reply';
import { phoneMessagesWaiting } from '../../reply/in-flight';
import { publishedCatalog } from '../../session-catalog';
import { queuedForMessage } from '../../task-dispatch/worker/queue-depth';
import { dispatchSessionObservation } from '../../task-dispatch/worker/readiness';
import { onAutomationsChanged } from '../controls/relay';
import type { StoredAutomation } from '../store';
import { AutomationRunner, chatHold, type ChatSnapshot } from '.';

/** How often the monitor looks at the saved automations. A minute-by-minute cron still runs each minute. */
export const AUTOMATION_PASS_MS = 15_000;

export type AutomationMonitorInput = {
  client: RelayClient;
  isLeader: () => boolean;
  publish: () => Promise<void>;
  /** True while a runtime update drains the monitor; nothing new starts then. */
  held?: () => boolean;
  /** Counts a delivery as monitor work until it is taken, so an update never cuts it off. */
  track?: <T>(work: () => Promise<T>) => Promise<T>;
  /** Hands a run to its chat; `handleUserMessage`, as for a phone message, unless a test replaces it. */
  deliver?: (message: UserMessage) => Promise<string | undefined>;
};

/** Phone messages for the chat that go first: in the durable queue, and in memory behind a run. */
function queuedFor(room: string, sessionId: string): number {
  try { return phoneMessagesWaiting(sessionId) + queuedForMessage(room, { sessionId }); } catch { return 1; }
}

/** What this monitor knows about the automation's chat now. */
function snapshot(input: AutomationMonitorInput, row: StoredAutomation): ChatSnapshot {
  const catalog = publishedCatalog(input.client);
  const listed = [...(catalog?.sessions ?? []), ...(catalog?.history ?? [])].find(item => item.sessionId === row.sessionId);
  const observed = dispatchSessionObservation(listed, catalog?.generatedAt);
  const queued = queuedFor(input.client.room, row.sessionId);
  let continuation = false;
  try { continuation = limitContinuationFor(row.sessionId).continuation !== undefined; } catch { continuation = true; }
  let readings: ChatSnapshot['readings'] = [];
  try { readings = cachedNativeAccountUsage(); } catch { /* No readings: only the chat's own refusal holds it. */ }
  return { agent: row.agent, session: observed.session, catalogAt: observed.generatedAt,
    inFlight: isDeliveryInFlight(row.sessionId), paused: isSessionPaused(row.sessionId), queued,
    updating: input.held?.() === true, continuation, readings };
}

/** The run goes into its chat exactly as a phone message does. Resolves to why the chat refused it. */
async function deliver(input: AutomationMonitorInput, message: UserMessage): Promise<string | undefined> {
  const track = input.track ?? (work => work());
  return track(async () => {
    if (input.deliver) return input.deliver(message);
    let refusal: string | undefined;
    const outcome = await handleUserMessage(input.client, message, undefined, undefined, undefined,
      async error => { refusal = error; }, () => queuedFor(input.client.room, message.sessionId!));
    void input.publish().catch(() => {});
    return outcome === 'accepted' ? undefined : refusal ?? 'The chat did not take the message.';
  });
}

/**
 * Runs GrantTap automations in the persistent monitor while it leads phone routing. Session MCP servers
 * never run them. Returns the stop function.
 */
export function startTaskAutomations(input: AutomationMonitorInput): () => void {
  const runner = new AutomationRunner({ hold: (row, now) => chatHold(snapshot(input, row), now),
    deliver: message => deliver(input, message) });
  let stopped = false;
  const tick = () => { if (!stopped && input.isLeader()) void runner.tick().catch(() => {}); };
  onAutomationsChanged(tick);
  const interval = setInterval(tick, AUTOMATION_PASS_MS); interval.unref();
  tick();
  return () => { stopped = true; clearInterval(interval); onAutomationsChanged(undefined); };
}
