/**
 * Handoff readiness.
 *
 * A Task Capsule carries facts, not files: the destination starts a worktree
 * from a commit. Anything still uncommitted stays on the source computer while
 * the Task continues elsewhere. That is the person's call, so it is said out
 * loud — on the phone, here, and in the capsule — rather than refused.
 */
import type { ResourceClaim, TaskCapsule } from "../../../../../packages/protocol/schema";

export const UNCOMMITTED_WORK_WARNING =
  "This task has uncommitted changes. They stay on this computer; the next agent starts from the last commit.";

/** "We could not look" is not "clean", so an unread tree is warned about too. */
export const UNREADABLE_WORKING_TREE_WARNING =
  "GrantTap could not read this working tree, so uncommitted changes may stay on this computer.";

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

function workingTreeWarning(capsule?: TaskCapsule): string | undefined {
  if (capsule?.workspaceMode) return undefined;
  switch (workingTree(capsule)) {
    case "clean": return undefined;
    case "dirty": return UNCOMMITTED_WORK_WARNING;
    default: return UNREADABLE_WORKING_TREE_WARNING;
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
        ? capsule.workspaceMode ? "Continue in the same working folder on this computer."
          : `Commit ${capsule.latestCommit ?? capsule.baseSha} in ${capsule.repository}`
        : "No transferable workspace was found. A folder without Git can continue on this computer without checkpoint or push.",
    ),
    check("workingTree", Boolean(capsule), workingTreeWarning(capsule) ?? (capsule?.workspaceMode ? "Shared working folder" : "Clean")),
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
  const leftBehind = capsule ? workingTreeWarning(capsule) : undefined;
  // Same module, different file: the merge conflict that has not happened
  // yet. Said out loud, not enforced — two agents can share a module.
  const overlaps = (input.moduleOverlaps ?? []).slice(0, 8).map((claim) =>
    `${claim.ownerSessionId} is working in the same module (${claim.resource}).`);
  const warnings = [...(leftBehind ? [leftBehind] : []), ...overlaps];
  return { ready: !blocked, blockedReason: blocked?.detail, checks, warnings };
}
