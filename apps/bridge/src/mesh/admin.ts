/**
 * What the person may do to the mesh that no agent may.
 *
 * A claim is released by its owner, and only its owner: that is what keeps
 * one agent from clearing another's hold on a file. It also means a claim
 * whose owner died, or will not let go, stays until it expires. The person
 * is not an owner and is not bound by that rule; they are the authority the
 * rule protects. A release from the phone is therefore a command of its
 * own, checked against the Project it names, and written down.
 */
import type {
  MeshClaimRelease,
  MeshClaimReleaseResult,
  ResourceClaim,
} from "../../../../packages/protocol/schema";
import type { MeshStore } from "./store";

export type PersonRelease =
  | { released: true; claim: ResourceClaim }
  | { released: false; reason: "unknown_claim" | "other_project" };

/** The answer the phone that asked is given, done or refused and why. */
export function releaseResult(
  request: MeshClaimRelease,
  outcome: PersonRelease,
  now = Date.now(),
): MeshClaimReleaseResult {
  return {
    type: "mesh.claim.release.result",
    sessionId: request.projectId,
    projectId: request.projectId,
    claimId: request.claimId,
    ok: outcome.released,
    ...(outcome.released ? {} : { reason: outcome.reason, detail: describe(outcome.reason) }),
    ...(request.requestId ? { requestId: request.requestId } : {}),
    generatedAt: now,
  };
}

function describe(reason: "unknown_claim" | "other_project"): string {
  return reason === "unknown_claim"
    ? "No such claim on this computer; it may already be gone."
    : "That claim belongs to another Project.";
}

export function releaseClaimByPerson(
  store: MeshStore,
  request: MeshClaimRelease,
  log: (line: string) => void = (line) => process.stderr.write(`[monitor] mesh: ${line}\n`),
): PersonRelease {
  // The claim must be one of this Project's: a claim id is not a secret, and
  // a Project's person does not reach into another Project with it.
  const inProject = store.snapshot(request.projectId)?.claims.find((item) => item.claimId === request.claimId);
  if (!inProject) {
    const elsewhere = store.activeClaims().some((item) => item.claimId === request.claimId);
    log(`release of ${request.claimId} refused: ${elsewhere ? "not in this Project" : "no such claim"}`);
    return { released: false, reason: elsewhere ? "other_project" : "unknown_claim" };
  }
  store.releaseClaim(request.claimId);
  log(
    `claim ${request.claimId} on ${inProject.resource} held by ${inProject.ownerSessionId} `
    + `released by the person${request.reason ? `: ${request.reason}` : ""}`,
  );
  return { released: true, claim: inProject };
}
