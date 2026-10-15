import type { CodingAgent, SessionInfo } from "../../../../../packages/protocol/schema";
import { readStoreState } from "../../../../bridge/src/mesh/store/state";

/** Same-user control still requires one exact execution on this computer. */
export function localTaskSession(query: Record<string, unknown>, storePath: string,
  endpointId: string): SessionInfo | undefined {
  const { project_id: projectId, task_id: taskId, session_id: sessionId } = query;
  if (![projectId, taskId, sessionId].every(value => typeof value === "string"
    && value.trim().length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value))) return undefined;
  const loaded = readStoreState(storePath);
  if (loaded.status !== "ok") return undefined;
  const tasks = loaded.state.tasks.filter(item => item.taskId === taskId);
  const executions = loaded.state.executions.filter(item => item.sessionId === sessionId);
  const execution = executions[0];
  if (tasks.length !== 1 || tasks[0]!.projectId !== projectId || executions.length !== 1
    || !execution || execution.taskId !== taskId || execution.computerId !== endpointId || !execution.workspace
    || !["claude", "codex", "cursor", "grok"].includes(execution.provider)) return undefined;
  return {
    sessionId: sessionId as string, agent: execution.provider as CodingAgent,
    projectId: projectId as string, taskId: taskId as string, computerId: endpointId,
    cwd: execution.workspace, state: execution.endedAt == null ? "working" : "idle",
    startedAt: execution.startedAt,
    lastActivityAt: execution.activeAt ?? execution.updatedAt ?? execution.startedAt,
    tokensSession: 0, tokensLastTurn: 0,
  };
}
