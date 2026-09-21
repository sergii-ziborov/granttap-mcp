import type { MeshSnapshot, SessionInfo } from "../../../../../../packages/protocol/schema";
import { resolve } from "node:path";

/** Native scans omit Mesh identity; bind them only to exact local executions. */
export function projectExecutionCapabilitySessions(
  snapshot: MeshSnapshot,
  sessions: SessionInfo[],
  localComputer: string,
  inventory?: (session: SessionInfo) => SessionInfo,
): SessionInfo[] {
  const result: SessionInfo[] = [];
  const bySession = new Map<string, MeshSnapshot["executions"]>();
  for (const execution of snapshot.executions) {
    const group = bySession.get(execution.sessionId) ?? [];
    group.push(execution);
    bySession.set(execution.sessionId, group);
  }
  for (const session of sessions) {
    if (session.projectId && session.projectId !== snapshot.projectId) continue;
    for (const execution of bySession.get(session.sessionId) ?? []) {
      if (execution.provider !== session.agent) continue;
      if (session.computerId && session.computerId !== execution.computerId) continue;
      if (session.cwd && execution.workspace && ![execution.workspace, execution.worktree]
        .some((path) => path && resolve(path) === resolve(session.cwd!))) continue;
      const local = execution.computerId === localComputer;
      if (!local && !session.computerId) continue;
      const linked = {
        ...session, projectId: snapshot.projectId, computerId: execution.computerId,
      };
      result.push(local ? inventory?.(linked) ?? linked : linked);
    }
  }
  return result;
}
