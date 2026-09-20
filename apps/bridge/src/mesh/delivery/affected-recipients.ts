export type AffectedRecipient = {
  sessionId: string;
  reason: "owner" | "claim" | "dependency";
};

export type AffectedChange = {
  taskId?: string;
  resources?: string[];
};

/**
 * Who is touched by a Project change. The person still confirms before
 * Write to agents sends. Dependencies and claims are evidence, not a new store.
 */
export function affectedRecipients(
  snapshot: {
    executions: Array<{ sessionId: string; taskId: string }>;
    claims: Array<{ ownerSessionId: string; resource: string; taskId: string }>;
    dependencies: Array<{ taskId: string; dependsOnTaskId: string }>;
  },
  change: AffectedChange,
): { recipients: AffectedRecipient[]; confirmRequired: true } {
  const seen = new Map<string, AffectedRecipient>();
  const add = (sessionId: string, reason: AffectedRecipient["reason"]) => {
    if (!seen.has(sessionId)) seen.set(sessionId, { sessionId, reason });
  };
  if (change.taskId) {
    for (const execution of snapshot.executions) {
      if (execution.taskId === change.taskId) add(execution.sessionId, "owner");
    }
    const related = new Set<string>([change.taskId]);
    for (const dependency of snapshot.dependencies) {
      if (dependency.taskId === change.taskId) related.add(dependency.dependsOnTaskId);
      if (dependency.dependsOnTaskId === change.taskId) related.add(dependency.taskId);
    }
    for (const execution of snapshot.executions) {
      if (related.has(execution.taskId) && execution.taskId !== change.taskId) {
        add(execution.sessionId, "dependency");
      }
    }
  }
  for (const resource of change.resources ?? []) {
    for (const claim of snapshot.claims) {
      if (claim.resource === resource) add(claim.ownerSessionId, "claim");
    }
  }
  return { recipients: [...seen.values()], confirmRequired: true };
}
