import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CodingAgent, UserMessage, type MeshEvent } from '../../../../../packages/protocol/schema';
import type { RelayClient } from '../../../../../packages/core/relay-client';
import { PeerTaskDispatch, PeerTaskResult } from '../../../../../packages/protocol/task-network';
import type { MeshStore } from '../../mesh/store';
import type { createMeshRuntime, MeshRuntimeDependencies } from '../../mesh/runtime';
import { localMeshStore } from '../../mesh/local-remote/local';
import { localTaskTransfers, type PreparedTaskTransfers } from '../../task-transfer';
import { observedComputerId } from '../../mesh/identity/computer';
import { NativeTaskQueueSender, type NativeQueueScope } from '../../task-dispatch';
import { configDir, loadConfig, machineConfigPath } from '../../config';
import { capsuleHash, handoffReceipt } from '../../mesh/handoff';

type Options = { store?: MeshStore; transfers?: PreparedTaskTransfers; endpointId?: string;
  runtime?: (send: MeshRuntimeDependencies['send']) => ReturnType<typeof createMeshRuntime>;
  queue?: (scope: NativeQueueScope, operation: UserMessage, notBefore: number, createdAt: number) => Promise<unknown> };

/** Called only after receiver Project-peer authentication and a durable relay claim. */
export async function prepareNetworkTransfer(input: PeerTaskDispatch, options: Options = {}): Promise<PeerTaskResult> {
  const job = PeerTaskDispatch.parse(input), operation = job.operation, capsule = operation.event.payload.capsule!;
  const store = options.store ?? localMeshStore(), transfers = options.transfers ?? localTaskTransfers();
  const endpointId = options.endpointId ?? observedComputerId();
  const project = store.project(operation.projectId), task = store.task(operation.taskId);
  const previous = transfers.forEvent(operation.event.eventId);
  if (!project || project.canonicalRepositoryId !== capsule.repository || capsule.targetComputer !== endpointId
    || !store.workspaceForRepository(capsule.repository, endpointId)) {
    return refusal(job, endpointId, 'No authorized local checkout matches this Project.');
  }
  if (task && (task.projectId !== operation.projectId || !previous && task.ownerSessionId != null
    && task.ownerSessionId !== operation.sourceExecution.sessionId && !operation.sourceExecution.continuedAt)) {
    return refusal(job, endpointId, 'This Task has another current owner. Refresh the Project before transferring.');
  }
  if (!task) store.upsertTask(operation.task);
  store.linkExecution(operation.sourceExecution);
  let reply: MeshEvent | undefined;
  const send: MeshRuntimeDependencies['send'] = async (_, payload) => {
    if (payload.type === 'mesh.event' && payload.taskId === operation.taskId
      && payload.projectId === operation.projectId && ['HANDOFF_ACCEPTED', 'HANDOFF_REJECTED'].includes(payload.eventType)) reply = payload;
  };
  const runtime = options.runtime ? options.runtime(send)
    : (await import('../../mesh/runtime')).createLocalMeshRuntime({ send, store: () => store,
      transfers: () => transfers, computer: () => endpointId });
  // The scoped result port replaces relay sending for this prepared-only event.
  await runtime.handle({} as RelayClient, operation.event);
  if (!reply) throw new Error('The Project did not produce a transfer receipt.');
  const destination = store.snapshot(operation.projectId)?.executions.find(execution =>
    execution.sessionId === reply?.payload.receipt?.targetSessionId);
  const result = PeerTaskResult.parse({ type: 'mesh.task.result', jobId: job.jobId,
    projectId: operation.projectId, taskId: operation.taskId, event: reply, destination });
  const receipt = result.event.payload.receipt;
  if (result.event.eventType === 'HANDOFF_ACCEPTED' && receipt && operation.forward) {
    await forwardFirstMessage(job, receipt.targetSessionId, transfers, options.queue);
  }
  return result;
}

async function forwardFirstMessage(job: PeerTaskDispatch, targetSessionId: string,
  transfers: PreparedTaskTransfers, queue?: Options['queue']): Promise<void> {
  const capsule = job.operation.event.payload.capsule!, forward = job.operation.forward!;
  const provider = CodingAgent.parse(capsule.targetProvider);
  const session = transfers.catalog([]).find(value => value.sessionId === targetSessionId);
  if (!session) throw new Error('The prepared transfer is unavailable for its first message.');
  // The parent's original due time may be weeks old after an offline computer reconnects.
  // Use the durable destination preparation time so child admission is fresh and idempotent.
  const createdAt = session.startedAt, notBefore = Math.max(job.notBefore, createdAt);
  const messageId = `peer-first-${createHash('sha256').update(job.jobId).digest('hex').slice(0, 48)}`;
  const scope = { projectId: job.operation.projectId, taskId: job.operation.taskId, sessionId: targetSessionId, provider };
  const operation = UserMessage.parse({ type: 'user.message', messageId, projectId: job.operation.projectId,
    sessionId: targetSessionId, agent: provider, cwd: session.worktree ?? session.cwd, text: forward.text,
    createdAt,
    ...(forward.attachments?.length ? { attachments: forward.attachments } : {}),
    model: forward.model ?? capsule.targetModel, effort: forward.effort });
  const submit = queue ?? (async (scope, message, notBefore, createdAt) => {
    const sender = new NativeTaskQueueSender({ root: join(configDir(), 'native-task-queue'), config: loadConfig(machineConfigPath()) });
    try { return await sender.submit(scope, message, notBefore, createdAt); }
    catch (error) {
      if (!sender.hasStaged(scope, message, notBefore, createdAt)) throw error;
      // The persistent sender owns this exact child message now, including retries.
      return { durable: true };
    }
  });
  await submit(scope, operation, notBefore, createdAt);
}

function refusal(job: PeerTaskDispatch, endpointId: string, reason: string): PeerTaskResult {
  const operation = job.operation, now = Date.now();
  return PeerTaskResult.parse({ type: 'mesh.task.result', jobId: job.jobId,
    projectId: operation.projectId, taskId: operation.taskId, event: { type: 'mesh.event', sessionId: operation.taskId,
      eventId: randomUUID(), projectId: operation.projectId, taskId: operation.taskId,
      sourceSessionId: `computer:${endpointId}`, targetSessionId: operation.event.sourceSessionId,
      eventType: 'HANDOFF_REJECTED', createdAt: now, expiresAt: now + 86_400_000,
      payload: { reason, failed: true, needsUser: true } } });
}

/** Recovery reports only an already-durable destination, without creating or forwarding work. */
export async function recoverNetworkTransfer(input: PeerTaskDispatch, options: Options = {}): Promise<PeerTaskResult> {
  const job = PeerTaskDispatch.parse(input), operation = job.operation;
  const transfers = options.transfers ?? localTaskTransfers(), endpointId = options.endpointId ?? observedComputerId();
  const existing = transfers.forEvent(operation.event.eventId);
  if (!existing) return refusal(job, endpointId, 'The Project was revoked before the destination was prepared.');
  if (existing.projectId !== operation.projectId || existing.sourceSessionId !== operation.event.sourceSessionId
    || capsuleHash(existing.capsule) !== capsuleHash(operation.event.payload.capsule!)) {
    throw new Error('The saved transfer has a different scope.');
  }
  const receipt = handoffReceipt(existing.capsule, existing.sourceSessionId, existing.sessionId, existing.acceptedAt);
  receipt.prepared = true;
  const now = Date.now();
  return PeerTaskResult.parse({ type: 'mesh.task.result', jobId: job.jobId, projectId: operation.projectId,
    taskId: operation.taskId, destination: { taskId: operation.taskId, sessionId: existing.sessionId,
      provider: existing.capsule.targetProvider, computerId: endpointId, workspace: existing.workspace,
      worktree: existing.workspace, branch: existing.branch, startedAt: existing.acceptedAt, state: 'idle' },
    event: { type: 'mesh.event', sessionId: operation.taskId, eventId: randomUUID(),
      projectId: operation.projectId, taskId: operation.taskId, sourceSessionId: existing.sessionId,
      targetSessionId: existing.sourceSessionId, eventType: 'HANDOFF_ACCEPTED', createdAt: now,
      expiresAt: now + 86_400_000, payload: { receipt, ...(operation.forward ? {
        summary: 'The destination is prepared. Check the first message in its chat after recovery.',
      } : {}) } } });
}
