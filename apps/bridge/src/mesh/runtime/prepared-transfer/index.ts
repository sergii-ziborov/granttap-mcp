import type { MeshEvent, SessionInfo, TaskCapsule } from '../../../../../../packages/protocol/schema';
import type { MeshRuntimeDependencies } from '../dependencies';
import { captureTransferContext } from '../../../task-transfer';

/** The private computer transport owns context; phone notifications are observations only. */
export function preparedHandoffMetadata(event: MeshEvent): MeshEvent {
  const { transferContext: _context, ...payload } = event.payload;
  return { ...event, payload };
}

/** Retains the original archive facts so reconfirmation hashes the same conversation. */
export async function capturePreparedHandoff(deps: MeshRuntimeDependencies, session: SessionInfo, facts: TaskCapsule) {
  const capture = deps.captureTransferContext ?? captureTransferContext;
  const captured = await capture(session, facts);
  const task = deps.store().task(facts.taskId);
  return { transferContext: captured.context,
    capsule: { ...facts, title: task?.title ?? session.title ?? facts.goal.slice(0, 160),
      launch: 'on_message' as const, contextHash: captured.hash },
    confirm: async () => {
      const current = deps.sessions().find(row => row.sessionId === session.sessionId);
      if (!current || current.state === 'working' || current.model !== session.model || current.effort !== session.effort
        || (current.worktree ?? current.cwd) !== (session.worktree ?? session.cwd)
        || deps.sourceCaptureCurrent && !deps.sourceCaptureCurrent(current, facts)) return false;
      try { return (await capture(current, facts)).hash === captured.hash; }
      catch { return false; }
    } };
}
