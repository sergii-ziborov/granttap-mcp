import { join } from 'node:path';
import type { PeerConfig, RelayClient } from '../../../../../packages/core/relay-client';
import { configDir, isSessionPaused } from '../../config';
import { isDeliveryInFlight } from '../../reply';
import { publishedCatalog } from '../../session-catalog';
import { handleUserMessage } from '../../monitor/handlers/user-message';
import { handleTaskCreate } from '../../monitor/handlers/task-create';
import { TaskDispatchInbox } from '../index';
import { TaskDispatchWorker } from './index';
import { relayTaskJobRemote } from './remote';
import { NativeTaskQueueSender } from '../sender';
import { queuedCatalogRefreshDue, taskDispatchReady } from './readiness';
import { localTaskOrigins, resolveTaskOriginJob } from '../../task-origins';

/** Only the persistent monitor advertises durable submission capability. */
export function startTaskDispatchMonitor(input: {
  config: PeerConfig; client: RelayClient; isLeader: () => boolean;
  peerAllowed: (peer: string) => boolean; publish: () => Promise<void>;
}): () => void {
  const inbox = new TaskDispatchInbox(join(configDir(), 'task-dispatch'), input.config.room);
  const origins = localTaskOrigins();
  const resolve = (job: Parameters<typeof resolveTaskOriginJob>[1], peer: string) =>
    resolveTaskOriginJob(origins, job, input.config.room, peer);
  let stopped = false, reportedAt = 0, maintainedAt = 0, refreshedAt = 0;
  const sender = new NativeTaskQueueSender({ root: join(configDir(), 'native-task-queue'), config: input.config });
  const peerAllowed = (peer: string) => peer === input.config.myPublicKey || input.peerAllowed(peer);
  const worker = new TaskDispatchWorker({ inbox, remote: relayTaskJobRemote(input.config),
    connected: () => !stopped && input.client.isConnected && input.isLeader(),
    authorized: peerAllowed,
    onTerminal: job => sender.confirmReceiverOutcome(job),
    onError: () => reportFailure(),
    conversationKey: (job, peer) => resolve(job, peer).job?.sessionId
      ?? (job.operation.type === 'user.message.continue'
        ? JSON.stringify([peer, job.operation.originMessageId]) : `new:${job.operation.agent ?? 'codex'}`),
    validationCode: (job, peer) => {
      const state = resolve(job, peer).state;
      return state === 'uncertain' ? 'confirmation_required'
        : state === 'failed' ? 'delivery_failed' : state === 'conflict' ? 'policy_denied' : undefined;
    },
    ready: (original, peer) => {
      const job = resolve(original, peer).job;
      if (!job) return false;
      const catalog = publishedCatalog(input.client);
      const session = [...(catalog?.sessions ?? []), ...(catalog?.history ?? [])]
        .find(item => item.sessionId === job.sessionId);
      const observation = { session, generatedAt: catalog?.generatedAt,
        inFlight: isDeliveryInFlight(job.sessionId ?? `__new_${job.operation.agent ?? 'codex'}_task__`),
        paused: !!job.sessionId && isSessionPaused(job.sessionId) };
      const ready = taskDispatchReady(job, observation);
      if (!ready && queuedCatalogRefreshDue(job, observation, refreshedAt)) {
        refreshedAt = Date.now();
        void input.publish().catch(() => {});
      }
      return ready;
    },
    deliver: async (original, beforeStart, peer) => {
      const job = resolve(original, peer).job;
      if (!job || job.operation.type === 'user.message.continue') return 'rejected';
      const outcome = job.operation.type === 'user.message'
        ? await handleUserMessage(input.client, job.operation, beforeStart, peer)
        : (await handleTaskCreate(input.client, job.operation, beforeStart)).status;
      void input.publish().catch(() => {});
      return outcome;
    },
  });
  const reportFailure = () => {
    if (Date.now() - reportedAt < 60_000) return;
    reportedAt = Date.now();
    process.stderr.write('[monitor] Durable task queue needs storage or relay recovery. No prompt was replayed.\n');
  };
  const tick = () => {
    if (Date.now() - maintainedAt > 3_600_000) {
      maintainedAt = Date.now(); void inbox.maintain().catch(reportFailure);
    }
    void worker.tick().catch(reportFailure);
    if (!stopped && input.client.isConnected && input.isLeader()) void sender.retryPending().catch(reportFailure);
  };
  const off = input.client.onTaskDispatch((job, peer) => {
    if (stopped || !input.isLeader() || !peerAllowed(peer)) return;
    try { if (inbox.stage(job, peer) !== 'conflict') tick(); }
    catch { reportFailure(); }
  });
  const interval = setInterval(tick, 2_000); interval.unref();
  tick();
  return () => { stopped = true; clearInterval(interval); off(); };
}
