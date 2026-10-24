import type { PreparedTransfer } from '../../../task-transfer';
import { isTerminalTaskState, nextTaskRevision } from '../../admin/convergence';
import { MeshStoreBase } from '../base';
import { validStoredReceipt } from './index';
import { capsuleHash } from '../../handoff';
import type { StoreState } from '../state';

/** Repairs only an unstarted, durably accepted local preparation. */
export class MeshPreparedStore extends MeshStoreBase {
  reconcilePreparedTransfers(rows: PreparedTransfer[], verify: (row: PreparedTransfer) => boolean): number {
    this.sync();
    if (!rows.some(row => repairable(this.state, row))) return 0;
    const result = this.transact(() => {
      let repaired = 0;
      for (const row of rows) {
        const facts = repairable(this.state, row);
        if (!facts || !verify(row)) continue;
        const at = Math.max(this.now(), (facts.destination.endedAt ?? 0) + 1, facts.task.updatedAt);
        facts.destination.endedAt = undefined;
        facts.destination.preparedVerifiedAt = at;
        facts.destination.updatedAt = at;
        facts.task.ownerSessionId = row.sessionId;
        facts.task.state = 'planned';
        facts.task.updatedAt = at;
        facts.task.revision = nextTaskRevision(facts.task);
        repaired += 1;
      }
      return repaired;
    });
    return result.applied ? result.value : 0;
  }
}

function repairable(state: StoreState, row: PreparedTransfer) {
  if (row.phase !== 'prepared' || row.nativeSessionId) return undefined;
  const task = state.tasks.find(item => item.taskId === row.capsule.taskId && item.projectId === row.projectId);
  if (!task || isTerminalTaskState(task.state)
    || ![row.sourceSessionId, row.sessionId].includes(task.ownerSessionId ?? '')) return undefined;
  const destination = state.executions.find(item => item.taskId === task.taskId && item.sessionId === row.sessionId
    && item.provider === row.capsule.targetProvider && item.computerId === row.capsule.targetComputer
    && item.workspace === row.workspace && item.startedAt === row.acceptedAt);
  if (!destination || destination.endedAt == null && task.ownerSessionId === row.sessionId) return undefined;
  const request = state.events.find(item => item.eventId === row.eventId && item.eventType === 'HANDOFF_REQUEST'
    && item.taskId === task.taskId && item.projectId === row.projectId && item.sourceSessionId === row.sourceSessionId);
  if (!request || state.events.some(item => item.taskId === task.taskId && item.eventType === 'HANDOFF_REQUEST'
    && item.eventId !== row.eventId && item.createdAt >= request.createdAt)) return undefined;
  const accepted = state.events.find(item => item.eventType === 'HANDOFF_ACCEPTED' && item.taskId === task.taskId
    && item.projectId === row.projectId && item.sourceSessionId === row.sessionId
    && item.payload.receipt?.prepared === true && item.payload.receipt.targetSessionId === row.sessionId
    && item.payload.receipt.sourceSessionId === row.sourceSessionId && item.payload.receipt.acceptedAt >= row.acceptedAt
    && item.payload.receipt.capsuleHash === capsuleHash(row.capsule));
  const source = state.executions.find(item => item.taskId === task.taskId && item.sessionId === row.sourceSessionId);
  if (!accepted || !validStoredReceipt(state, accepted) || !source?.endedAt
    || source.continuedAt != null && source.continuedAt >= row.acceptedAt) return undefined;
  return { task, destination };
}
