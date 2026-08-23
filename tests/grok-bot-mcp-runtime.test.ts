import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateTransferKey } from "../packages/core/crypto";
import { RelayClient } from "../packages/core/relay-client";
import type { MeshEvent, TaskCapsule } from "../packages/protocol/schema";
import { createPairing } from "../apps/bridge/src/config";
import { localMeshStore, resetLocalMeshStore } from "../apps/bridge/src/mesh/local";
import { createGrokBotMeshServer } from "../apps/mcp/src/mesh-server";
import { resetGrokBotRelay } from "../apps/mcp/src/mcp-tools/mesh-relay";
import { saveTestGrokBotEndpoint } from "./support/grok-bot-endpoint";
import { connectInMemory, textResult } from "./support/mcp-client";
import { forwardingRelay, waitFor } from "./support/forwarding-relay";

const projectId = "granttap-project";
const taskId = "pairing-task";
const actorId = "qa";

function capsule(createdAt: number): TaskCapsule {
  return {
    taskId, goal: "Verify reconnect", currentStatus: "Implementation ready",
    sourceProvider: "claude", sourceComputer: "MacBook", targetProvider: "grok_bot",
    targetComputer: "Grok Bot Cloud", targetActorId: actorId,
    repository: "github.com/example/granttap", baseSha: "a".repeat(40),
    branch: "claude/reconnect", latestCommit: "b".repeat(40), filesChanged: ["src/reconnect.ts"],
    testsStatus: "Unit tests pass", dependencies: [], resourceClaims: [],
    remainingWork: ["Run external verification"], importantDecisions: ["Keep task identity"],
    createdAt,
  };
}

function seedMesh(createdAt: number): void {
  const store = localMeshStore();
  store.upsertProject({
    projectId, name: "GrantTap", repositoryRoot: "/repo",
    canonicalRepositoryId: "github.com/example/granttap", createdAt,
  });
  store.upsertTask({
    taskId, projectId, title: "Pairing", goal: "Verify reconnect", state: "working",
    ownerSessionId: "grok-session", createdAt, updatedAt: createdAt,
  });
  store.linkExecution({
    taskId, sessionId: "grok-session", provider: "grok_bot", actorId,
    computerId: "grok-cloud", workspace: "/repo", branch: "qa/reconnect", startedAt: createdAt,
  });
  store.acceptEvent({
    type: "mesh.event", sessionId: taskId, eventId: "question-event", projectId, taskId,
    sourceSessionId: "codex-source", targetSessionId: "grok-session",
    eventType: "AGENT_QUESTION", createdAt, expiresAt: createdAt + 86_400_000,
    payload: { question: "Which result field?", category: "technical" },
  });
  for (const [eventId, targetActorId] of [
    ["accept-request", actorId],
    ["reject-request", actorId],
  ] as const) {
    store.acceptEvent({
      type: "mesh.event", sessionId: taskId, eventId, projectId, taskId,
      sourceSessionId: "claude-source", eventType: "HANDOFF_REQUEST",
      createdAt, expiresAt: createdAt + 86_400_000,
      payload: { capsule: { ...capsule(createdAt), targetActorId } },
    });
  }
}

test("Grok Bot MCP executes every scoped Mesh operation over E2EE", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-grok-runtime-"));
  const relay = await forwardingRelay();
  const paired = createPairing(relay.url);
  const createdAt = Date.now();
  process.env.GRANTTAP_CONFIG_DIR = root;
  resetLocalMeshStore();
  resetGrokBotRelay();
  t.after(async () => {
    resetGrokBotRelay();
    resetLocalMeshStore();
    delete process.env.GRANTTAP_CONFIG_DIR;
    await relay.close();
  });
  saveTestGrokBotEndpoint({
    pairing: paired.machineCfg, projectIds: [projectId], actorId, createdAt,
  });
  seedMesh(createdAt);

  const phone = new RelayClient(paired.phoneCfg);
  const received: MeshEvent[] = [];
  phone.onMessage((payload) => {
    if (payload.type === "mesh.event") received.push(payload);
    return true;
  });
  await phone.connect();
  t.after(() => phone.close());
  const client = await connectInMemory(createGrokBotMeshServer());
  t.after(() => client.close());
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const scope = { actorId, projectId, taskId };

  assert.equal((await call("mesh_status", { actorId, projectId })).isError, undefined);
  await waitFor(() => relay.connections() === 2);
  const taskKey = generateTransferKey();
  phone.setSessionKey(taskId, taskKey);
  await phone.send({
    type: "session.key.grant", sessionId: taskId, key: taskKey,
    purpose: "task", createdAt: Date.now(),
  }, "machine");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal((await call("mesh_task", scope)).isError, undefined);
  assert.equal((await call("mesh_task", { ...scope, taskId: "missing" })).isError, true);
  assert.equal((await call("mesh_progress", { ...scope, summary: "Running regression" })).isError, undefined);
  const claimed = await call("mesh_claim", { ...scope, resource: "tests/reconnect/**", ttlSeconds: 120 });
  const claimEvent = JSON.parse(textResult(claimed)) as MeshEvent;
  assert.equal(claimEvent.eventType, "RESOURCE_CLAIM");
  assert.equal((await call("mesh_release", { ...scope, claimId: "missing" })).isError, true);
  assert.equal((await call("mesh_release", {
    ...scope, claimId: claimEvent.payload.claim?.claimId,
  })).isError, undefined);
  const asked = await call("mesh_question", {
    ...scope, question: "Is the fixture ready?", targetSessionId: "codex-source", category: "technical",
  });
  assert.equal((JSON.parse(textResult(asked)) as MeshEvent).eventType, "AGENT_QUESTION");
  assert.equal((await call("mesh_answer", {
    ...scope, questionEventId: "missing", answer: "No",
  })).isError, true);
  assert.equal((await call("mesh_answer", {
    ...scope, questionEventId: "question-event", answer: "Use connectionId",
  })).isError, undefined);
  assert.equal((await call("mesh_artifact_ready", {
    ...scope, reference: "commit:91ac82",
  })).isError, undefined);
  assert.equal((await call("mesh_complete", { ...scope, summary: "Verification passed" })).isError, undefined);
  assert.equal((await call("mesh_handoff", {
    ...scope, targetProvider: "codex", targetComputer: "Workstation",
    currentStatus: "Regression found", baseSha: "a".repeat(40), branch: "qa/reconnect",
    latestCommit: "b".repeat(40), filesChanged: ["src/reconnect.ts"],
    testsStatus: "One regression", remainingWork: ["Fix reconnect"],
    importantDecisions: ["Keep connectionId"],
  })).isError, undefined);
  assert.equal((await call("mesh_reject_handoff", {
    ...scope, requestEventId: "missing", reason: "Not addressed",
  })).isError, true);
  assert.equal((await call("mesh_reject_handoff", {
    ...scope, requestEventId: "reject-request", reason: "Busy",
  })).isError, undefined);
  assert.equal((await call("mesh_accept_handoff", {
    ...scope, requestEventId: "missing",
  })).isError, true);
  assert.equal((await call("mesh_accept_handoff", {
    ...scope, requestEventId: "accept-request",
  })).isError, undefined);
  await waitFor(() => received.length >= 9);
  assert.equal(localMeshStore().task(taskId)?.ownerSessionId?.startsWith("grok-bot:qa:"), true);
});
