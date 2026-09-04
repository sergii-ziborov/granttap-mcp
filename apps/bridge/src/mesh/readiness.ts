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

/** An unread working tree blocks the move; only a positive "clean" releases it. */
export const UNREADABLE_WORKING_TREE_REASON =
  "GrantTap could not read this working tree, so it cannot promise a commit carries every change.";

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
  /** Worth a look before continuing; never a reason to refuse. */
  warnings: string[];
};

export type HandoffReadinessInput = {
  capsule?: TaskCapsule;
  targetProviderEnabled: boolean;
  conflicts: ResourceClaim[];
  /** Claims in the same module as this Task's own: a warning, never a block. */
  moduleOverlaps?: ResourceClaim[];
};

function check(id: HandoffCheckId, ready: boolean, detail: string): HandoffCheck {
  return { id, ready, detail };
}

function workingTree(capsule?: TaskCapsule): "clean" | "dirty" | "unknown" {
  if (capsule?.dirtyDiffHash != null) return "dirty";
  return capsule?.workingTree ?? "unknown";
}

function workingTreeDetail(capsule?: TaskCapsule): string {
  switch (workingTree(capsule)) {
    case "clean": return "Clean";
    case "dirty": return UNCOMMITTED_WORK_REASON;
    default: return UNREADABLE_WORKING_TREE_REASON;
  }
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
      Boolean(capsule) && workingTree(capsule) === "clean",
      workingTreeDetail(capsule),
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
  // Same module, different file: the merge conflict that has not happened
  // yet. Said out loud, not enforced — two agents can share a module.
  const warnings = (input.moduleOverlaps ?? []).slice(0, 8).map((claim) =>
    `${claim.ownerSessionId} is working in the same module (${claim.resource}).`);
  return { ready: !blocked, blockedReason: blocked?.detail, checks, warnings };
}
