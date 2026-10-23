import type { RelayClient } from "../../../../../../packages/core/relay-client";
import type { MeshHandoffPrepare, SessionInfo } from "../../../../../../packages/protocol/schema";
import type { MeshRuntimeDependencies } from "../dependencies";
import type { createHandoffFlow } from "../handoff";
import { workingTreeState } from "../../catalog";
import { createCheckpoint } from "../../admin/checkpoint";
import { buildTaskCapsule } from "../../admin/capsule";
import { handoffReadiness } from "../../tasks/readiness";

/** Read source facts once, preserving the person's checkpoint choice. */
export async function prepareSourceCapsule(input: { deps: MeshRuntimeDependencies;
  blockHandoff: ReturnType<typeof createHandoffFlow>["blockHandoff"]; client: RelayClient;
  request: MeshHandoffPrepare; session: SessionInfo; sessions: SessionInfo[] }) {
  const { deps, blockHandoff, client, request, session, sessions } = input;
  const cwd = session.worktree ?? session.cwd;
  const made = request.checkpoint && cwd && workingTreeState(cwd) === "dirty"
    ? createCheckpoint(cwd, request.taskId, session.title ?? request.taskId, request.createdAt)
    : undefined;
  const shared = made && cwd
    ? sessions.some((other) =>
      other.sessionId !== session.sessionId
      && other.taskId != null && other.taskId !== request.taskId
      && (other.worktree ?? other.cwd) === cwd)
    : false;
  const checkpoint = made && shared ? { ...made, status: "requires_review" as const } : made;
  const capsule = buildTaskCapsule(deps.store(), session, request, deps.computer(), checkpoint);
  const readiness = handoffReadiness({
    capsule,
    targetProviderEnabled: request.targetProvider === "grok_bot"
      || deps.providerEnabled(request.targetProvider),
    conflicts: (capsule?.resourceClaims ?? []).flatMap((resource) =>
      deps.store().conflicts(request.projectId, request.sessionId, resource, {
        repositoryId: capsule?.repository, endpointId: deps.computer(), worktree: cwd,
      }, true)),
    moduleOverlaps: (capsule?.resourceClaims ?? []).flatMap((resource) =>
      deps.store().moduleOverlaps(request.projectId, request.sessionId, resource, {
        repositoryId: capsule?.repository, endpointId: deps.computer(), worktree: cwd,
      })),
  });
  if (!readiness.ready) {
    await blockHandoff(client, request, readiness.blockedReason ?? "Handoff is not ready.");
    return undefined;
  }
  return capsule;
}
