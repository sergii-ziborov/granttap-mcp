import { ExecutionSessionLink, MeshEvent, type MeshEvent as Event } from '../../../../../../packages/protocol/schema';
import { capsuleHash } from '../../handoff';
import { preferExecution } from '../../admin/convergence';
import type { StoreState } from '../state';

export function validStoredReceipt(state: StoreState, event: Event): boolean {
  const receipt = event.payload.receipt;
  if (!receipt || receipt.taskId !== event.taskId) return false;
  const request = [...state.events].reverse().find(item => item.eventType === 'HANDOFF_REQUEST'
    && item.projectId === event.projectId && item.taskId === event.taskId
    && item.sourceSessionId === receipt.sourceSessionId && item.payload.capsule != null);
  if (!request?.payload.capsule) return false;
  const digest = capsuleHash(request.payload.capsule);
  return digest === receipt.capsuleHash || state.migrations.some(item => item.taskIdTo === event.taskId
    && item.capsuleHashTo === digest && item.capsuleHashFrom === receipt.capsuleHash);
}

/** Past authenticated results may restore bounded metadata, never supersede a newer transfer. */
export function restoreHandoffResult(state: StoreState, input: Event, response: Event,
  target: unknown, apply: (event: Event) => void): boolean {
  const request = MeshEvent.parse(input), event = MeshEvent.parse(response);
  const capsule = request.payload.capsule, receipt = event.payload.receipt;
  const task = state.tasks.find(row => row.taskId === request.taskId && row.projectId === request.projectId);
  if (!task || request.eventType !== 'HANDOFF_REQUEST' || !capsule || request.payload.transferContext
    || event.projectId !== request.projectId || event.taskId !== request.taskId
    || event.targetSessionId !== request.sourceSessionId
    || !['HANDOFF_ACCEPTED', 'HANDOFF_REJECTED'].includes(event.eventType)) return false;
  const newer = state.events.some(row => row.eventType === 'HANDOFF_REQUEST' && row.taskId === request.taskId
    && row.sourceSessionId === request.sourceSessionId && row.eventId !== request.eventId
    && row.createdAt >= request.createdAt);
  const owner = state.executions.find(row => row.taskId === task.taskId && row.sessionId === task.ownerSessionId);
  if (newer || owner && owner.sessionId !== request.sourceSessionId
    && owner.sessionId !== receipt?.targetSessionId && owner.startedAt > request.createdAt) return false;
  if (state.events.some(row => row.eventId === event.eventId)) return true;
  const source = state.executions.find(row => row.taskId === request.taskId && row.sessionId === request.sourceSessionId);
  if (source?.computerId !== capsule.sourceComputer) return false;
  let destination: ExecutionSessionLink | undefined;
  if (event.eventType === 'HANDOFF_ACCEPTED') {
    destination = ExecutionSessionLink.parse(target);
    if (!receipt?.prepared || receipt.capsuleHash !== capsuleHash(capsule)
      || receipt.sourceSessionId !== request.sourceSessionId || receipt.taskId !== task.taskId
      || event.sourceSessionId !== receipt.targetSessionId || destination.sessionId !== receipt.targetSessionId
      || destination.computerId !== capsule.targetComputer || destination.provider !== capsule.targetProvider
      || destination.taskId !== task.taskId) return false;
  }
  if (!state.events.some(row => row.eventId === request.eventId)) state.events.push(request);
  if (destination) {
    const prior = state.executions.find(row => row.sessionId === destination.sessionId
      && row.computerId === destination.computerId && row.provider === destination.provider);
    state.executions = state.executions.filter(row => row !== prior);
    state.executions.push(prior ? preferExecution(prior, destination) : destination);
  }
  state.events.push(event);
  state.events = state.events.slice(-512);
  apply(event);
  return true;
}
