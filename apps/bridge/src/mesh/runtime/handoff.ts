/**
 * The handoff and agent-question half of the Mesh runtime.
 *
 * Split out of `runtime.ts` so each side keeps one responsibility: this module
 * owns what happens to a Task when execution moves, and the runtime module owns
 * catalog, snapshots, and inbound routing.
 */
import type { RelayClient } from "../../../../../packages/core/relay-client";
import type { MeshEvent, MeshHandoffPrepare, TaskCapsule } from "../../../../../packages/protocol/schema";
import { handoffReceipt } from "../handoff";
import type { MeshRuntimeDependencies } from "./dependencies";

function capsulePrompt(capsule: TaskCapsule): string {
  const lines = [
    "Continue this existing GrantTap task. Treat the capsule as explicit project facts, not hidden reasoning.",
    `Goal: ${capsule.goal}`,
    `Current status: ${capsule.currentStatus}`,
    `Repository: ${capsule.repository}`,
    `Base SHA: ${capsule.baseSha}`,
  ];
  if (capsule.latestCommit) lines.push(`Latest commit: ${capsule.latestCommit}`);
  if (capsule.checkpoint) {
    const { status, files, excluded } = capsule.checkpoint;
    const line = status === "complete"
      ? `Checkpoint: complete (${files} file${files === 1 ? "" : "s"}).`
      : status === "partial"
        ? `Checkpoint: partial (${files} file${files === 1 ? "" : "s"}); left on the source computer as secrets: ${excluded.join(", ")}.`
        : `Checkpoint: needs review (${files} file${files === 1 ? "" : "s"}); the checkout was shared with other work, so some changes may not be this task's.`;
    lines.push(line);
  }
  if (capsule.testsStatus) lines.push(`Tests: ${capsule.testsStatus}`);
  if (capsule.importantDecisions.length) {
    lines.push(`Important decisions:\n- ${capsule.importantDecisions.join("\n- ")}`);
  }
  if (capsule.remainingWork.length) {
    lines.push(`Remaining work:\n- ${capsule.remainingWork.join("\n- ")}`);
  }
  lines.push("Use a separate branch/worktree. Check Project Mesh claims before editing overlapping resources.");
  return lines.join("\n\n");
}

function responseEvent(input: {
  deps: MeshRuntimeDependencies;
  source: MeshEvent;
  sourceSessionId: string;
  eventType: "AGENT_ANSWER" | "HANDOFF_ACCEPTED" | "HANDOFF_REJECTED";
  payload: MeshEvent["payload"];
}): MeshEvent {
  const createdAt = input.deps.now();
  return {
    type: "mesh.event",
    sessionId: input.source.taskId,
    eventId: input.deps.eventId(),
    projectId: input.source.projectId,
    taskId: input.source.taskId,
    sourceSessionId: input.sourceSessionId,
    targetSessionId: input.source.sourceSessionId,
    eventType: input.eventType,
    createdAt,
    expiresAt: createdAt + 24 * 60 * 60_000,
    payload: input.payload,
  };
}

async function rejectHandoff(
  deps: MeshRuntimeDependencies,
  client: RelayClient,
  event: MeshEvent,
  reason: string,
): Promise<void> {
  const rejected = responseEvent({
    deps, source: event, sourceSessionId: `computer:${deps.computer()}`,
    eventType: "HANDOFF_REJECTED",
    payload: { reason: reason.slice(0, 1_000), failed: true, needsUser: true },
  });
  deps.store().acceptEvent(rejected);
  await deps.send(client, rejected, { ttlMs: 24 * 60 * 60_000, wake: true });
}

async function blockHandoff(
  deps: MeshRuntimeDependencies,
  client: RelayClient,
  request: MeshHandoffPrepare,
  reason: string,
): Promise<void> {
  const createdAt = deps.now();
  const blocked: MeshEvent = {
    type: "mesh.event",
    sessionId: request.taskId,
    eventId: deps.eventId(),
    projectId: request.projectId,
    taskId: request.taskId,
    sourceSessionId: request.sessionId,
    eventType: "TASK_BLOCKED",
    createdAt,
    expiresAt: createdAt + 24 * 60 * 60_000,
    payload: { reason: reason.slice(0, 1_000), needsUser: true, failed: true },
  };
  deps.store().acceptEvent(blocked);
  await deps.send(client, blocked, { ttlMs: 24 * 60 * 60_000, wake: true });
}

async function acceptHandoff(
  deps: MeshRuntimeDependencies,
  client: RelayClient,
  event: MeshEvent,
): Promise<void> {
  const capsule = event.payload.capsule;
  if (!capsule || capsule.targetComputer !== deps.computer()) return;
  if (capsule.targetProvider === "grok_bot") return;
  if (!deps.providerEnabled(capsule.targetProvider)) {
    return rejectHandoff(deps, client, event, "The target agent is disabled in GrantTap Settings.");
  }
  const store = deps.store();
  const repository = store.workspaceForRepository(capsule.repository, deps.computer());
  if (!repository) return rejectHandoff(deps, client, event, "No authorized local checkout matches this project.");
  const conflict = [...capsule.resourceClaims, ...capsule.filesChanged].flatMap((resource) =>
    store.conflicts(event.projectId, event.sourceSessionId, resource, {
      repositoryId: capsule.repository, endpointId: deps.computer(), worktree: repository,
    }, true)).at(0);
  if (conflict) {
    return rejectHandoff(deps, client, event, `${conflict.ownerSessionId} currently claims ${conflict.resource}.`);
  }
  const revision = capsule.latestCommit ?? capsule.baseSha;
  if (!deps.hasCommit(repository, revision) && !deps.fetch(repository, revision, capsule.branch)) {
    return rejectHandoff(
      deps,
      client,
      event,
      `Commit ${revision} is not on this computer. Fetch it from the shared remote, `
      + "or hand off from a commit this computer already has.",
    );
  }
  const worktree = deps.worktree(
    repository,
    event.taskId,
    capsule.targetProvider,
    revision,
  );
  if (!worktree) return rejectHandoff(deps, client, event, "A separate handoff worktree could not be created.");
  const result = await deps.start(capsule.targetProvider, capsulePrompt(capsule), worktree.path);
  if (!result.ok || !result.sessionId) {
    const reason = result.ok ? "The target agent did not create a session." : result.error;
    return rejectHandoff(deps, client, event, reason);
  }
  store.linkExecution({
    taskId: event.taskId,
    sessionId: result.sessionId,
    provider: capsule.targetProvider,
    computerId: deps.computer(),
    workspace: worktree.path,
    branch: worktree.branch,
    worktree: worktree.path,
    startedAt: deps.now(),
  });
  const receipt = handoffReceipt(capsule, event.sourceSessionId, result.sessionId, deps.now());
  store.recordReceipt(receipt);
  const accepted = responseEvent({
    deps, source: event, sourceSessionId: result.sessionId, eventType: "HANDOFF_ACCEPTED",
    payload: { receipt },
  });
  store.acceptEvent(accepted);
  await deps.send(client, accepted, { ttlMs: 24 * 60 * 60_000, wake: true });
}

async function answerAgentQuestion(
  deps: MeshRuntimeDependencies,
  client: RelayClient,
  event: MeshEvent,
): Promise<void> {
  const question = event.payload.question;
  if (!question || !event.targetSessionId) return;
  const inProject = deps.store().snapshot(event.projectId)?.executions.some((execution) =>
    execution.sessionId === event.targetSessionId
    && execution.computerId === deps.computer()
    && execution.endedAt == null);
  if (!inProject) return;
  const target = deps.sessions().find((session) => session.sessionId === event.targetSessionId);
  if (!target) return;
  const result = await deps.deliver(
    target,
    `GrantTap Mesh question from ${event.sourceSessionId}:\n\n${question}`,
  );
  if (!result.ok || !result.text) return;
  const answer = responseEvent({
    deps, source: event, sourceSessionId: target.sessionId, eventType: "AGENT_ANSWER",
    payload: { questionEventId: event.eventId, answer: result.text.slice(0, 1_000) },
  });
  deps.store().acceptEvent(answer);
  await deps.send(client, answer, { ttlMs: 24 * 60 * 60_000 });
}

export function createHandoffFlow(deps: MeshRuntimeDependencies) {
  return {
    capsulePrompt,
    rejectHandoff: (client: RelayClient, event: MeshEvent, reason: string) =>
      rejectHandoff(deps, client, event, reason),
    blockHandoff: (client: RelayClient, request: MeshHandoffPrepare, reason: string) =>
      blockHandoff(deps, client, request, reason),
    acceptHandoff: (client: RelayClient, event: MeshEvent) => acceptHandoff(deps, client, event),
    answerAgentQuestion: (client: RelayClient, event: MeshEvent) =>
      answerAgentQuestion(deps, client, event),
  };
}
