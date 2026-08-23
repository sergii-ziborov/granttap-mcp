import assert from "node:assert/strict";
import test from "node:test";
import {
  ExecutionSessionLink,
  MeshHandoffPrepare,
  MeshActor,
  MeshEndpoint,
  MeshEndpointPolicy,
  MeshScopedCredential,
  MeshEvent,
  MeshSnapshot,
  Payload,
  Project,
  TaskCapsule,
} from "../packages/protocol/schema";

const now = 1_800_000_000_000;

function capsule(): Record<string, unknown> {
  return {
    taskId: "task-pairing",
    goal: "Finish pairing regression coverage",
    currentStatus: "Crypto changes are committed",
    sourceProvider: "claude",
    sourceComputer: "macbook",
    targetProvider: "codex",
    targetComputer: "workstation",
    repository: "github.com/example/granttap",
    baseSha: "a".repeat(40),
    latestCommit: "b".repeat(40),
    filesChanged: ["packages/pairing/crypto.ts"],
    testsStatus: "Unit tests pass",
    dependencies: ["task-api"],
    resourceClaims: ["packages/pairing/**"],
    remainingWork: ["Run the cross-computer regression suite"],
    importantDecisions: ["Use connectionId as the stable field name"],
    createdAt: now,
  };
}

function handoffEvent(): Record<string, unknown> {
  return {
    type: "mesh.event",
    sessionId: "task-pairing",
    eventId: "event-handoff",
    projectId: "project-granttap",
    taskId: "task-pairing",
    sourceSessionId: "claude-session",
    targetSessionId: "codex-session",
    eventType: "HANDOFF_REQUEST",
    createdAt: now,
    expiresAt: now + 300_000,
    payload: { capsule: capsule() },
  };
}

test("mesh protocol accepts only the four supported execution providers", () => {
  const base = {
    taskId: "task",
    sessionId: "native-session",
    computerId: "computer",
    workspace: "/repo",
    branch: "codex/tests",
    startedAt: now,
  };
  for (const provider of ["claude", "codex", "cursor", "grok"]) {
    assert.equal(ExecutionSessionLink.safeParse({ ...base, provider }).success, true);
  }
  assert.equal(ExecutionSessionLink.safeParse({ ...base, provider: "retired-provider" }).success, false);
  assert.equal(ExecutionSessionLink.safeParse({
    ...base, provider: "grok_bot", actorId: "qa-bot",
  }).success, true);
  assert.equal(ExecutionSessionLink.safeParse({ ...base, provider: "grok_bot" }).success, false);
});

test("Grok Bot endpoint and actors share one scoped cryptographic principal", () => {
  const endpoint = {
    endpointId: "grok-cloud", kind: "grok_bot_cloud", displayName: "Grok Bot Cloud",
    publicKey: "A".repeat(43), credentialId: "credential", status: "active",
    createdAt: now,
  };
  assert.equal(MeshEndpoint.safeParse(endpoint).success, true);
  assert.equal(MeshActor.safeParse({
    actorId: "qa-bot", endpointId: endpoint.endpointId, kind: "persistent_agent",
    displayName: "QA Bot", status: "idle", enabled: true,
  }).success, true);
  assert.equal(MeshScopedCredential.safeParse({
    credentialId: "credential", endpointId: endpoint.endpointId,
    status: "active", projectIds: ["project-granttap"], operations: ["status", "progress"],
    issuedAt: now, expiresAt: now + 60_000,
  }).success, true);
  assert.equal(MeshEndpointPolicy.safeParse({
    type: "mesh.endpoint.policy", endpointId: endpoint.endpointId,
    credentialId: "credential", enabled: true, status: "active",
    projectIds: ["project-granttap"], actors: [{ actorId: "qa-bot", enabled: true }],
    revision: 1, createdAt: now,
  }).success, true);
});

test("projects have a bounded canonical repository identity", () => {
  assert.equal(Project.safeParse({
    projectId: "project-granttap",
    name: "GrantTap",
    repositoryRoot: "/repo",
    canonicalRepositoryId: "github.com/example/granttap",
    baseRemote: "git@github.com:example/granttap.git",
    createdAt: now,
  }).success, true);
  assert.equal(Project.safeParse({
    projectId: "project",
    name: "x".repeat(161),
    canonicalRepositoryId: "repo",
    createdAt: now,
  }).success, false);
});

test("Task Capsule is bounded and cannot carry hidden reasoning", () => {
  assert.equal(TaskCapsule.safeParse(capsule()).success, true);
  assert.equal(TaskCapsule.safeParse({
    ...capsule(),
    hiddenReasoning: "private chain of thought",
  }).success, false);
  assert.equal(TaskCapsule.safeParse({
    ...capsule(), targetProvider: "grok_bot", targetActorId: "qa-bot",
  }).success, true);
  assert.equal(TaskCapsule.safeParse({ ...capsule(), targetProvider: "grok_bot" }).success, false);
  assert.equal(TaskCapsule.safeParse({
    ...capsule(),
    importantDecisions: Array.from({ length: 17 }, () => "fact"),
  }).success, false);
});

test("handoff events are task-scoped, bounded, and part of Payload", () => {
  const event = handoffEvent();
  assert.equal(MeshEvent.safeParse(event).success, true);
  assert.equal(Payload.safeParse(event).success, true);
  assert.equal(MeshEvent.safeParse({ ...event, sessionId: "other-task" }).success, false);
  assert.equal(MeshEvent.safeParse({
    ...event,
    payload: { capsule: capsule(), reasoning: "do not replicate this" },
  }).success, false);
  assert.equal(MeshEvent.safeParse({
    ...event,
    eventType: "RESOURCE_CLAIM",
    payload: { claim: {
      claimId: "claim", projectId: "different-project", taskId: "task-pairing",
      ownerSessionId: "claude-session", resource: "src/auth/**", mode: "claim",
      createdAt: now, expiresAt: now + 60_000,
    } },
  }).success, false);
});

test("phone handoff preparation is an explicit bounded route request", () => {
  const request = {
    type: "mesh.handoff.prepare",
    sessionId: "claude-native",
    projectId: "project-granttap",
    taskId: "task-pairing",
    targetProvider: "codex",
    targetComputer: "workstation",
    createdAt: now,
  };
  assert.equal(MeshHandoffPrepare.safeParse(request).success, true);
  assert.equal(Payload.safeParse(request).success, true);
  assert.equal(MeshHandoffPrepare.safeParse({ ...request, targetProvider: "retired-provider" }).success, false);
});

test("project snapshots cannot smuggle task state across project scope", () => {
  const project = {
    projectId: "project-granttap", name: "GrantTap",
    canonicalRepositoryId: "github.com/example/granttap", createdAt: now,
  };
  const task = {
    taskId: "task-pairing", projectId: project.projectId, title: "Pairing",
    goal: "Finish pairing", state: "working", createdAt: now, updatedAt: now,
  };
  const snapshot = {
    type: "mesh.snapshot", sessionId: project.projectId, projectId: project.projectId,
    project, tasks: [task], executions: [], claims: [], dependencies: [], events: [],
    generatedAt: now,
  };
  assert.equal(MeshSnapshot.safeParse(snapshot).success, true);
  assert.equal(MeshSnapshot.safeParse({
    ...snapshot, tasks: [{ ...task, projectId: "different-project" }],
  }).success, false);
});
