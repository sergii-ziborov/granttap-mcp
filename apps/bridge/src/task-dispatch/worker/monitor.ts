import { join } from 'node:path';
import type { PeerConfig, RelayClient } from '../../../../../packages/core/relay-client';
import { configDir, isSessionPaused } from '../../config';
import { isDeliveryInFlight } from '../../reply';
import { scanSessions } from '../../sessions';
import { handleUserMessage } from '../../monitor/handlers/user-message';
import { handleTaskCreate } from '../../monitor/handlers/task-create';
import { TaskDispatchInbox } from '../index';
import { TaskDispatchWorker } from './index';
import { relayTaskJobRemote } from './remote';
import { NativeTaskQueueSender } from '../sender';

/** Only the persistent monitor advertises durable submission capability. */
export function startTaskDispatchMonitor(input: {
  config: PeerConfig; client: RelayClient; isLeader: () => boolean;
  peerAllowed: (peer: string) => boolean; publish: () => Promise<void>;
}): () => void {
  const inbox = new TaskDispatchInbox(join(configDir(), 'task-dispatch'), input.config.room);
  let stopped = false, reportedAt = 0, maintainedAt = 0;
  const sender = new NativeTaskQueueSender({ root: join(configDir(), 'native-task-queue'), config: input.config });
  const peerAllowed = (peer: string) => peer === input.config.myPublicKey || input.peerAllowed(peer);
  const worker = new TaskDispatchWorker({ inbox, remote: relayTaskJobRemote(input.config),
    connected: () => !stopped && input.client.isConnected && input.isLeader(),
    authorized: peerAllowed,
    onTerminal: job => sender.confirmReceiverOutcome(job),
    onError: () => reportFailure(),
    ready: job => {
      if (!job.sessionId) return !isDeliveryInFlight(`__new_${job.operation.agent ?? 'codex'}_task__`);
      if (isDeliveryInFlight(job.sessionId)) return false;
      const session = scanSessions().sessions.find(item => item.sessionId === job.sessionId);
      // A missing chat is allowed through validation to produce a definite rejection.
      return !session || session.state === 'idle' && !isSessionPaused(job.sessionId);
    },
    deliver: async (job, beforeStart) => {
      const outcome = job.operation.type === 'user.message'
        ? await handleUserMessage(input.client, job.operation, beforeStart)
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
