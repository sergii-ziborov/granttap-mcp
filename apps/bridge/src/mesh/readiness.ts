/**
 * Handoff readiness.
 *
 * A Task Capsule carries facts, not files: the destination starts a worktree
 * from a commit. Anything still uncommitted stays on the source computer even
 * though the Task visibly continues elsewhere, so a handoff that would lose it
 * is refused instead of silently narrowing to committed state.
 */
import type { ResourceClaim, TaskCapsule } from "../../../../packages/protocol/schema";

export const UNCOMMITTED_WORK_REASON =
  "This task has uncommitted changes. Commit or checkpoint them before moving the task.";

export type HandoffCheckId = "repository" | "workingTree" | "claims" | "targetAgent";

export type HandoffCheck = {
  id: HandoffCheckId;
  ready: boolean;
  detail: string;
};

export type HandoffReadiness = {
  ready: boolean;
  blockedReason?: string;
  checks: HandoffCheck[];
};

export type HandoffReadinessInput = {
  capsule?: TaskCapsule;
  targetProviderEnabled: boolean;
  conflicts: ResourceClaim[];
};

function check(id: HandoffCheckId, ready: boolean, detail: string): HandoffCheck {
  return { id, ready, detail };
}

/** Every blocking condition the source computer can answer before publishing. */
export function handoffReadiness(input: HandoffReadinessInput): HandoffReadiness {
  const { capsule } = input;
  const conflict = input.conflicts.at(0);
  const checks: HandoffCheck[] = [
    check(
      "repository",
      Boolean(capsule),
      capsule
        ? `Commit ${capsule.latestCommit ?? capsule.baseSha} in ${capsule.repository}`
        : "No git repository, task, or commit was found for this execution.",
    ),
    check(
      "workingTree",
      Boolean(capsule) && capsule?.dirtyDiffHash == null,
      capsule?.dirtyDiffHash == null ? "Clean" : UNCOMMITTED_WORK_REASON,
    ),
    check(
      "claims",
      !conflict,
      conflict
        ? `${conflict.ownerSessionId} currently claims ${conflict.resource}.`
        : "No overlapping resource claims",
    ),
    check(
      "targetAgent",
      input.targetProviderEnabled,
      input.targetProviderEnabled
        ? "Ready"
        : "The target agent is disabled in GrantTap Settings.",
    ),
  ];
  const blocked = checks.find((item) => !item.ready);
  return { ready: !blocked, blockedReason: blocked?.detail, checks };
}
