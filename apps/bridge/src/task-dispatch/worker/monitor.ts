import { join } from 'node:path';
import type { PeerConfig, RelayClient } from '../../../../../packages/core/relay-client';
import { configDir, isSessionPaused } from '../../config';
import { isDeliveryInFlight, newTaskDeliveryKey } from '../../reply';
import { publishedCatalog } from '../../session-catalog';
import { handleUserMessage } from '../../monitor/handlers/user-message';
import { handleTaskCreate } from '../../monitor/handlers/task-create';
import { sendDeliveryArrival } from '../../monitor/handlers/receipts';
import { TaskDispatchInbox } from '../index';
import { TaskDispatchWorker, type TaskJobRemote, type WorkerOptions } from './index';
import { relayTaskJobRemote } from './remote';
import { NativeTaskQueueSender } from '../sender';
import { dispatchSessionObservation, newTaskOperationKey, queuedCatalogRefreshDue, taskDispatchReady } from './readiness';
import { localTaskOrigins, resolveTaskOriginJob } from '../../task-origins';

/** Only the persistent monitor advertises durable submission capability. */
export function startTaskDispatchMonitor(input: {
  config: PeerConfig; client: RelayClient; isLeader: () => boolean;
  peerAllowed: (peer: string) => boolean; publish: () => Promise<void>;
  remote?: TaskJobRemote; deliver?: WorkerOptions['deliver'];
}): () => void {
  const inbox = new TaskDispatchInbox(join(configDir(), 'task-dispatch'), input.config.room);
  const origins = localTaskOrigins();
  const resolve = (job: Parameters<typeof resolveTaskOriginJob>[1], peer: string) =>
    resolveTaskOriginJob(origins, job, input.config.room, peer);
  let stopped = false, reportedAt = 0, maintainedAt = 0, refreshedAt = 0;
  const waitingSince = new Map<string, number>();
  const sender = new NativeTaskQueueSender({ root: join(configDir(), 'native-task-queue'), config: input.config });
  const peerAllowed = (peer: string) => peer === input.config.myPublicKey || input.peerAllowed(peer);
  const worker = new TaskDispatchWorker({ inbox, remote: input.remote ?? relayTaskJobRemote(input.config),
    connected: () => !stopped && input.client.isConnected && input.isLeader(),
    authorized: peerAllowed,
    onTerminal: job => sender.confirmReceiverOutcome(job),
    onError: error => reportFailure(error),
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
      const observation = { ...dispatchSessionObservation(session, catalog?.generatedAt),
        inFlight: isDeliveryInFlight(job.sessionId
          ?? newTaskDeliveryKey(job.operation.agent ?? 'codex', newTaskOperationKey(job.operation))),
        paused: !!job.sessionId && isSessionPaused(job.sessionId) };
      const ready = taskDispatchReady(job, observation);
      if (!ready) { if (!waitingSince.has(job.jobId)) waitingSince.set(job.jobId, Date.now()); }
      else {
        const waited = Date.now() - (waitingSince.get(job.jobId) ?? Date.now());
        waitingSince.delete(job.jobId);
        if (waited >= 30_000) {
          process.stderr.write(`[monitor] A queued message waited ${Math.round(waited / 1000)} s for its chat to become free.\n`);
        }
      }
      if (!ready && queuedCatalogRefreshDue(job, observation, refreshedAt)) {
        refreshedAt = Date.now();
        void input.publish().catch(() => {});
      }
      return ready;
    },
    deliver: async (original, beforeStart, peer) => {
      if (input.deliver) return input.deliver(original, beforeStart, peer);
      const job = resolve(original, peer).job;
      if (!job || job.operation.type === 'user.message.continue') return 'rejected';
      const outcome = job.operation.type === 'user.message'
        ? await handleUserMessage(input.client, job.operation, beforeStart, peer)
        : (await handleTaskCreate(input.client, job.operation, beforeStart)).status;
      void input.publish().catch(() => {});
      return outcome;
    },
  });
  const reportFailure = (error: unknown) => {
    if (Date.now() - reportedAt < 60_000) return;
    reportedAt = Date.now();
    // Storage and relay errors name a status or a path, never a prompt.
    // A failed fetch keeps its reason (DNS, TLS, connect timeout) in `cause`.
    const reason = error instanceof Error && error.cause instanceof Error
      ? ` [${(error.cause as NodeJS.ErrnoException).code ?? error.cause.name}]` : '';
    const cause = error instanceof Error ? `${error.name}: ${error.message}${reason}`.slice(0, 200) : 'unknown';
    process.stderr.write(`[monitor] Durable task queue needs storage or relay recovery (${cause}). No prompt was replayed.\n`);
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
    try {
      const staged = inbox.stage(job, peer);
      if (staged === 'conflict') return;
      // The relay repeats its offer until a claim. Only the first one is news.
      if (staged !== 'existing' && job.operation.type === 'user.message' && job.operation.messageId) {
        void sendDeliveryArrival(input.client, job.operation.messageId, job.operation.sessionId,
          peer === input.config.myPublicKey ? undefined : peer);
      }
      tick();
    }
    catch (error) { reportFailure(error); }
  });
  const interval = setInterval(tick, 2_000); interval.unref();
  tick();
  return () => { stopped = true; clearInterval(interval); off(); };
}
