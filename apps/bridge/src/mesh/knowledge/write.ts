import type { KnowledgeWrite, KnowledgeWriteResult } from "../../../../../packages/protocol/schema";
import type { KnowledgeRecordInput } from "../../engine/protocol/engine-memory-protocol";

type Scope = {
  tasks: Array<{ taskId: string }>;
  bindings: Array<{ endpointId: string }>;
};

type Dependencies = {
  now: () => number;
  endpointId: string;
  snapshot: (projectId: string) => Scope | undefined;
  record: (input: KnowledgeRecordInput) => Promise<boolean>;
  send: (result: KnowledgeWriteResult) => Promise<void>;
};

/** A person's confirmed statement enters Memory only through a bound Project/Task. */
export async function handleKnowledgeWrite(
  request: KnowledgeWrite, deps: Dependencies,
): Promise<boolean> {
  const now = deps.now();
  const scope = deps.snapshot(request.projectId);
  let reason: string | undefined;
  if (!scope || !scope.bindings.some((item) => item.endpointId === deps.endpointId)
    || !scope.tasks.some((item) => item.taskId === request.taskId)) {
    reason = "Project, Task, or local computer binding is unavailable.";
  } else if (Math.abs(now - request.createdAt) > 5 * 60_000) {
    reason = "Decision request expired. Try again.";
  } else {
    const input: KnowledgeRecordInput = {
      project_id: request.projectId, task_id: request.taskId,
      record_id: request.recordId, category: "decision", content: request.content,
      source: "user_decision", source_ref: `phone:${request.recordId}`,
      visibility: "project", recorded_at: request.createdAt,
      ...(request.repositoryId ? { repository_id: request.repositoryId } : {}),
      ...(request.supersedesRecordId
        ? { supersedes_record_id: request.supersedesRecordId } : {}),
    };
    if (!await deps.record(input)) reason = "Memory did not confirm the decision.";
  }
  await deps.send({ type: "knowledge.write.result", projectId: request.projectId,
    taskId: request.taskId, recordId: request.recordId,
    status: reason ? "rejected" : "recorded", ...(reason ? { reason } : {}), createdAt: now });
  return true;
}
