import type { ExecutionSessionLink } from '../../../../../../packages/protocol/schema';
import { isTerminalTaskState, preferExecution } from '../../admin/convergence';
import type { StoreState } from '../state';

/** Ownership has already converged before availability; an ended former owner never qualifies. */
export function preferScopedExecution(state: StoreState, current: ExecutionSessionLink, incoming: ExecutionSessionLink) {
  const task = state.tasks.find(row => row.taskId === incoming.taskId);
  const preparedOwner = !!task && !isTerminalTaskState(task.state) && task.ownerSessionId === incoming.sessionId;
  return preferExecution(current, incoming, preparedOwner);
}
