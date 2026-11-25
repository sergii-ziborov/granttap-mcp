import { join } from 'node:path';
import type { PeerConfig, RelayClient } from '../../../../../packages/core/relay-client';
import type { TaskDispatch } from '../../../../../packages/protocol/schema';
import { configDir, isSessionPaused } from '../../config';
import { isDeliveryInFlight, newTaskDeliveryKey } from '../../reply';
import { publishedCatalog } from '../../session-catalog';
import { handleUserMessage } from '../../monitor/handlers/user-message';
import { handleTaskCreate } from '../../monitor/handlers/task-create';
import { sendDeliveryArrival, sendDeliveryReceipt } from '../../monitor/handlers/receipts';
import { TaskDispatchInbox } from '../index';
import { TaskDispatchWorker, type TaskJobRemote, type WorkerOptions } from './index';
import { relayTaskJobRemote } from './remote';
import { conversationKeyOf } from './queue-depth';
import { NativeTaskQueueSender } from '../sender';
import { dispatchSessionObservation, newTaskOperationKey, queuedCatalogRefreshDue, taskDispatchReady } from './readiness';
import { localTaskOrigins, OrphanFollowUps, ORPHAN_CODE, ORPHAN_REASON, resolveTaskOriginJob } from '../../task-origins';
import { queueFailureReporter } from './failure-report';
import { limitContinuationUnwanted, registerLimitContinuationQueue } from '../../limit-continuation';
import { limitCanHold, queueHeldByLimit } from '../../limit-queue-hold';
import { continueStoppedWork, registerStoppedWorkHandler } from '../../background-continuation';
import { phoneMessagesWaiting } from '../../reply/in-flight';
import { messageWaitsBehindRun } from '../../reply/background-wait';
import { queuedPhoneMessages } from './queue-depth';

/** The chat as this monitor last published it, from its live list or its history. */
function listedSession(client: RelayClient, sessionId: string | undefined) {
  const catalog = publishedCatalog(client);
  const session = [...(catalog?.sessions ?? []), ...(catalog?.history ?? [])].find(item => item.sessionId === sessionId);
  return { session, generatedAt: catalog?.generatedAt };
}

/** A queued phone message waits while its chat's usage limit holds the chat's queue (`limit-queue-hold`). */
function heldByLimit(client: RelayClient, job: TaskDispatch | undefined): boolean {
  return !!job?.sessionId && limitCanHold(job)
    && queueHeldByLimit(job.sessionId, dispatchSessionObservation(listedSession(client, job.sessionId).session).session);
}

/** A phone message takes its chat back from background work the chat's last turn left, as Claude Code did after ten minutes. */
function waitsBehindRun(job: TaskDispatch, inFlight: boolean, session: ReturnType<typeof listedSession>['session']): void {
  if (inFlight && job.sessionId && job.origin !== 'computer') messageWaitsBehindRun(job.sessionId, session);
}

/** Claude stopped background work a chat's turn left running: the chat is continued like a phone message. */
function continueStoppedChats(client: RelayClient, room: string, sender: NativeTaskQueueSender, live: () => boolean): void {
  registerStoppedWorkHandler((sessionId, work, at) => {
    if (!live()) return;
    void continueStoppedWork((scope, message, notBefore, createdAt) => sender.submit(scope, message, notBefore, createdAt),
      { sessionId, session: listedSession(client, sessionId).session,
        phoneMessagesWaiting: phoneMessagesWaiting(sessionId) + queuedPhoneMessages(sessionId, room) }, work, at);
  });
}

/**
 * A job is refused before it starts when its own new task cannot settle it: the creation needs
 * confirmation, failed, belongs to another chat, or never started here (`task-origins/orphans.ts`).
 * The last one also tells the phone why under the person's message, once.
 */
function refusalCode(input: { client: RelayClient; room: string; orphans: OrphanFollowUps; told: Set<string> },
  job: TaskDispatch, peer: string, stagedAt: number, state: string): string | undefined {
  if (state !== 'waiting') {
    return state === 'uncertain' ? 'confirmation_required'
      : state === 'failed' ? 'delivery_failed' : state === 'conflict' ? 'policy_denied' : undefined;
  }
  const operation = job.operation;
  if (operation.type !== 'user.message.continue'
    || !input.orphans.orphaned(job, { room: input.room, peerPublicKey: peer }, stagedAt)) return undefined;
  if (!input.told.has(job.jobId)) {
    input.told.add(job.jobId);
    process.stderr.write(`[monitor] A follow-up waited ${Math.round((Date.now() - stagedAt) / 60_000)} min for a new task `
      + 'that never started on this computer; it was refused.\n');
    void sendDeliveryReceipt(input.client, operation.messageId, 'rejected', ORPHAN_REASON, undefined, peer);
  }
  return ORPHAN_CODE;
}

/** Only the persistent monitor advertises durable submission capability. */
export function startTaskDispatchMonitor(input: {
  config: PeerConfig; client: RelayClient; isLeader: () => boolean;
  peerAllowed: (peer: string) => boolean; publish: () => Promise<void>;
  remote?: TaskJobRemote; deliver?: WorkerOptions['deliver'];
  /** True while a runtime update drains the monitor. A queued job then stays staged here and on the relay. */
  held?: () => boolean;
  /** Counts a delivery as monitor work until its handler returns, so an update cannot cut it off. */
  track?: <T>(work: () => Promise<T>) => Promise<T>;
}): () => void {
  const inbox = new TaskDispatchInbox(join(configDir(), 'task-dispatch'), input.config.room);
  const track = input.track ?? (work => work());
  const origins = localTaskOrigins();
  const resolve = (job: Parameters<typeof resolveTaskOriginJob>[1], peer: string) =>
    resolveTaskOriginJob(origins, job, input.config.room, peer);
  let stopped = false, maintainedAt = 0, refreshedAt = 0;
  const waitingSince = new Map<string, number>();
  const sender = new NativeTaskQueueSender({ root: join(configDir(), 'native-task-queue'), config: input.config });
  const peerAllowed = (peer: string) => peer === input.config.myPublicKey || input.peerAllowed(peer);
  registerLimitContinuationQueue({ submit: (scope, message, notBefore, createdAt) => sender.submit(scope, message, notBefore, createdAt),
    cancel: (scope, id) => sender.cancel(scope, id), status: (scope, id) => sender.lookup(scope, id) });
  continueStoppedChats(input.client, input.config.room, sender, () => !stopped);
  const remote = input.remote ?? relayTaskJobRemote(input.config);
  const refusal = { client: input.client, room: input.config.room, told: new Set<string>(), orphans: new OrphanFollowUps(
    { registry: origins, relayState: jobId => remote.get({ jobId }), onError: error => reportFailure(error) }) };
  const worker = new TaskDispatchWorker({ inbox, remote,
    connected: () => !stopped && input.client.isConnected && input.isLeader(),
    authorized: peerAllowed,
    onTerminal: job => sender.confirmReceiverOutcome(job),
    onError: error => reportFailure(error),
    conversationKey: conversationKeyOf((job, peer) => resolve(job, peer).job),
    validationCode: (job, peer, stagedAt) => refusalCode(refusal, job, peer, stagedAt, resolve(job, peer).state),
    limitHeld: (original, peer) => heldByLimit(input.client, resolve(original, peer).job),
    ready: (original, peer) => {
      const job = input.held?.() ? undefined : resolve(original, peer).job;
      if (!job) return false;
      const { session, generatedAt } = listedSession(input.client, job.sessionId);
      const observation = { ...dispatchSessionObservation(session, generatedAt),
        inFlight: isDeliveryInFlight(job.sessionId
          ?? newTaskDeliveryKey(job.operation.agent ?? 'codex', newTaskOperationKey(job.operation))),
        paused: !!job.sessionId && isSessionPaused(job.sessionId) };
      const ready = taskDispatchReady(job, observation);
      if (!ready) { waitsBehindRun(job, observation.inFlight, session); waitingSince.set(job.jobId, waitingSince.get(job.jobId) ?? Date.now()); }
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
    deliver: (original, beforeStart, peer, queued) => track(async () => {
      // A continuation goes only to a chat that has not gone on since its limit stopped it.
      const operation = original.operation;
      if (operation.type === 'user.message' && limitContinuationUnwanted(operation,
        () => dispatchSessionObservation(listedSession(input.client, operation.sessionId).session).session)) return 'rejected';
      if (input.deliver) return input.deliver(original, beforeStart, peer, queued);
      const job = resolve(original, peer).job;
      if (!job || job.operation.type === 'user.message.continue') return 'rejected';
      const outcome = job.operation.type === 'user.message'
        ? await handleUserMessage(input.client, job.operation, beforeStart, peer, undefined, undefined, queued)
        : (await handleTaskCreate(input.client, job.operation, beforeStart)).status;
      void input.publish().catch(() => {});
      return outcome;
    }),
  });
  const reportFailure = queueFailureReporter().report;
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
      // The relay repeats its offer until a claim. Only the first one is news. A follow-up written
      // before its chat existed arrives too: up to 0.8.209 the phone never heard that it was here.
      const operation = job.operation;
      if (staged !== 'existing' && operation.type !== 'project.task.create' && operation.messageId) {
        void sendDeliveryArrival(input.client, operation.messageId, job.sessionId,
          peer === input.config.myPublicKey ? undefined : peer);
      }
      tick();
    }
    catch (error) { reportFailure(error); }
  });
  const interval = setInterval(tick, 2_000); interval.unref();
  tick();
  return () => {
    stopped = true; clearInterval(interval); off(); registerLimitContinuationQueue(undefined); registerStoppedWorkHandler(undefined);
  };
}
