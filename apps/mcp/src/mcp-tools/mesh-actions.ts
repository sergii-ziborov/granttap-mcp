import { randomUUID } from "node:crypto";
import {
  MeshEvent,
  TaskCapsule,
  type MeshEvent as MeshEventValue,
  type MeshEventPayload,
  type MeshEventType,
  type MeshProvider,
} from "../../../../packages/protocol/schema";
import {
  authorizeGrokBotOperation,
  loadGrokBotEndpoint,
  saveGrokBotEndpoint,
} from "../../../bridge/src/mesh/endpoint";
import { handoffReceipt } from "../../../bridge/src/mesh/handoff";
import { localMeshStore } from "../../../bridge/src/mesh/local";
import { grokBotRelay, publishGrokBotEvent } from "./mesh-relay";

export type MeshScope = { actorId: string; projectId: string; taskId: string };

function actorSession(scope: MeshScope): string {
  const snapshot = localMeshStore().snapshot(scope.projectId);
  const task = snapshot?.tasks.find((item) => item.taskId === scope.taskId);
  const execution = snapshot?.executions.find((item) =>
    item.taskId === scope.taskId && item.actorId === scope.actorId
      && item.sessionId === task?.ownerSessionId && item.endedAt == null);
  if (!execution) throw new Error("This actor does not own the task execution");
  return execution.sessionId;
}

function event(
  scope: MeshScope,
  sourceSessionId: string,
  eventType: MeshEventType,
  payload: MeshEventPayload,
  targetSessionId?: string,
): MeshEventValue {
  const createdAt = Date.now();
  return MeshEvent.parse({
    type: "mesh.event", sessionId: scope.taskId, eventId: randomUUID(),
    projectId: scope.projectId, taskId: scope.taskId, sourceSessionId,
    sourceActorId: scope.actorId, targetSessionId, eventType, createdAt,
    expiresAt: createdAt + 24 * 60 * 60_000, payload,
  });
}

async function publish(value: MeshEventValue): Promise<MeshEventValue> {
  await publishGrokBotEvent(value);
  if (!localMeshStore().acceptEvent(value)) throw new Error("Mesh event was rejected locally");
  return value;
}

function authorize(scope: MeshScope, operation: Parameters<typeof authorizeGrokBotOperation>[0]["operation"]) {
  return authorizeGrokBotOperation({ ...scope, operation });
}

export function status(scope: Omit<MeshScope, "taskId">) {
  authorizeGrokBotOperation({ ...scope, operation: "status" });
  // A read is also the safe bootstrap point for the endpoint's encrypted
  // channel. Do not make local status availability depend on relay uptime.
  void grokBotRelay().catch(() => undefined);
  const snapshot = localMeshStore().snapshot(scope.projectId);
  return snapshot ? {
    project: snapshot.project,
    tasks: snapshot.tasks,
    executions: snapshot.executions,
    claims: snapshot.claims,
    dependencies: snapshot.dependencies,
    events: snapshot.events.slice(-32),
  } : { project: null, tasks: [], executions: [], claims: [], dependencies: [], events: [] };
}

export function task(scope: MeshScope) {
  authorize(scope, "task");
  const snapshot = localMeshStore().snapshot(scope.projectId);
  const selected = snapshot?.tasks.find((item) => item.taskId === scope.taskId);
  if (!snapshot || !selected) throw new Error("Task is outside this endpoint scope");
  return {
    task: selected,
    executions: snapshot.executions.filter((item) => item.taskId === scope.taskId),
    claims: snapshot.claims.filter((item) => item.taskId === scope.taskId),
    dependencies: snapshot.dependencies.filter((item) => item.taskId === scope.taskId),
    events: snapshot.events.filter((item) => item.taskId === scope.taskId).slice(-32),
  };
}

export async function progress(scope: MeshScope, summary: string) {
  authorize(scope, "progress");
  return publish(event(scope, actorSession(scope), "TASK_PROGRESS", { summary }));
}

export async function claim(scope: MeshScope, resource: string, ttlSeconds: number) {
  authorize(scope, "claim");
  const sessionId = actorSession(scope);
  const conflict = localMeshStore().conflicts(scope.projectId, sessionId, resource).at(0);
  if (conflict) throw new Error(`${conflict.ownerSessionId} currently claims ${conflict.resource}`);
  const createdAt = Date.now();
  return publish(event(scope, sessionId, "RESOURCE_CLAIM", { claim: {
    claimId: randomUUID(), projectId: scope.projectId, taskId: scope.taskId,
    ownerSessionId: sessionId, resource, mode: "claim", createdAt,
    expiresAt: createdAt + ttlSeconds * 1_000,
  } }));
}

export async function release(scope: MeshScope, claimId: string) {
  authorize(scope, "release");
  const sessionId = actorSession(scope);
  const snapshot = localMeshStore().snapshot(scope.projectId);
  const owned = snapshot?.claims.find((item) =>
    item.claimId === claimId && item.taskId === scope.taskId && item.ownerSessionId === sessionId);
  if (!owned) throw new Error("Claim is not owned by this actor");
  return publish(event(scope, sessionId, "RESOURCE_RELEASE", { claimId }));
}

export async function question(
  scope: MeshScope, text: string, targetSessionId: string | undefined,
  category: "technical" | "product" | "business" | "security" | "destructive",
) {
  authorize(scope, "question");
  return publish(event(scope, actorSession(scope), "AGENT_QUESTION", {
    question: text, category,
  }, targetSessionId));
}

export async function answer(scope: MeshScope, questionEventId: string, text: string) {
  authorize(scope, "answer");
  const snapshot = localMeshStore().snapshot(scope.projectId);
  const source = snapshot?.events.find((item) =>
    item.eventId === questionEventId && item.taskId === scope.taskId
      && item.eventType === "AGENT_QUESTION");
  if (!source) throw new Error("Question is not available in this task");
  return publish(event(scope, actorSession(scope), "AGENT_ANSWER", {
    questionEventId, answer: text,
  }, source.sourceSessionId));
}

export async function artifact(scope: MeshScope, reference: string) {
  authorize(scope, "artifact_ready");
  return publish(event(scope, actorSession(scope), "ARTIFACT_READY", { artifact: reference }));
}

export async function complete(scope: MeshScope, summary: string) {
  authorize(scope, "complete");
  return publish(event(scope, actorSession(scope), "TASK_COMPLETED", { summary }));
}

export async function accept(scope: MeshScope, requestEventId: string) {
  const bundle = authorize(scope, "accept_handoff");
  const snapshot = localMeshStore().snapshot(scope.projectId);
  const request = snapshot?.events.find((item) => item.eventId === requestEventId
    && item.taskId === scope.taskId && item.eventType === "HANDOFF_REQUEST");
  const capsule = request?.payload.capsule;
  if (!request || !capsule || capsule.targetProvider !== "grok_bot"
    || capsule.targetActorId !== scope.actorId) throw new Error("Handoff is not addressed to this actor");
  const sessionId = `grok-bot:${scope.actorId}:${randomUUID()}`;
  const receipt = handoffReceipt(capsule, request.sourceSessionId, sessionId);
  const accepted = event(
    scope, sessionId, "HANDOFF_ACCEPTED", { receipt }, request.sourceSessionId,
  );
  // Delivery must succeed before local ownership changes. A disconnected
  // endpoint leaves the original handoff pending and preserves one owner.
  await publishGrokBotEvent(accepted);
  if (!localMeshStore().acceptEvent(accepted)) {
    throw new Error("Handoff acceptance was rejected locally");
  }
  localMeshStore().linkExecution({
    taskId: scope.taskId, sessionId, provider: "grok_bot", actorId: scope.actorId,
    computerId: bundle.endpoint.endpointId, workspace: capsule.repository,
    branch: capsule.branch, startedAt: Date.now(),
  });
  localMeshStore().recordReceipt(receipt);
  updateActorStatus(scope.actorId, "working");
  return accepted;
}

export async function reject(scope: MeshScope, requestEventId: string, reason: string) {
  authorize(scope, "reject_handoff");
  const snapshot = localMeshStore().snapshot(scope.projectId);
  const request = snapshot?.events.find((item) => item.eventId === requestEventId
    && item.taskId === scope.taskId && item.eventType === "HANDOFF_REQUEST");
  if (!request || request.payload.capsule?.targetActorId !== scope.actorId) {
    throw new Error("Handoff is not addressed to this actor");
  }
  return publish(event(scope, `actor:${scope.actorId}`, "HANDOFF_REJECTED", {
    reason, failed: true, needsUser: true,
  }, request.sourceSessionId));
}

type HandoffInput = {
  targetProvider: MeshProvider; targetComputer: string; currentStatus: string;
  baseSha: string; branch?: string; latestCommit?: string; filesChanged: string[];
  testsStatus?: string; remainingWork: string[]; importantDecisions: string[];
};

export async function handoff(scope: MeshScope, input: HandoffInput) {
  authorize(scope, "handoff");
  const sourceSessionId = actorSession(scope);
  const snapshot = localMeshStore().snapshot(scope.projectId);
  const selected = snapshot?.tasks.find((item) => item.taskId === scope.taskId);
  if (!snapshot || !selected) throw new Error("Task is outside this endpoint scope");
  const capsule = TaskCapsule.parse({
    taskId: scope.taskId, goal: selected.goal, currentStatus: input.currentStatus,
    sourceProvider: "grok_bot", sourceActorId: scope.actorId,
    sourceComputer: loadGrokBotEndpoint()?.endpoint.displayName ?? "Grok Bot",
    targetProvider: input.targetProvider, targetComputer: input.targetComputer,
    repository: snapshot.project.canonicalRepositoryId, baseSha: input.baseSha,
    branch: input.branch, latestCommit: input.latestCommit, filesChanged: input.filesChanged,
    testsStatus: input.testsStatus,
    dependencies: snapshot.dependencies.filter((item) => item.taskId === scope.taskId)
      .map((item) => item.dependsOnTaskId),
    resourceClaims: snapshot.claims.filter((item) => item.taskId === scope.taskId)
      .map((item) => item.resource),
    remainingWork: input.remainingWork, importantDecisions: input.importantDecisions,
    createdAt: Date.now(),
  });
  return publish(event(scope, sourceSessionId, "HANDOFF_REQUEST", { capsule }));
}

function updateActorStatus(actorId: string, status: "idle" | "working" | "blocked" | "offline") {
  const bundle = loadGrokBotEndpoint();
  if (!bundle) return;
  bundle.actors = bundle.actors.map((actor) => actor.actorId === actorId ? { ...actor, status } : actor);
  saveGrokBotEndpoint(bundle);
}
