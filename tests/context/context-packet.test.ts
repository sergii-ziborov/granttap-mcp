import assert from "node:assert/strict";
import test from "node:test";
import { compileMeshContext } from "../../apps/bridge/src/mesh/context/packet";
import { parseProjectContextMode, renderCompactProjectContext, renderProjectContext } from "../../apps/bridge/src/mesh/context/project";
import { planBroadcast, retryable } from "../../apps/bridge/src/mesh/delivery";
import type { ScopedMeshView } from "../../apps/bridge/src/mesh/snapshot/scoped-view";

function view(overrides: Partial<ScopedMeshView> = {}): ScopedMeshView {
  return {
    schema: "granttap.mesh-scope.v1",
    generatedAt: 1,
    execution: {
      taskId: "task-1",
      sessionId: "session-1",
      provider: "cursor",
      computerId: "mac-1",
      workspace: "/tmp/repo",
      startedAt: 1,
    },
    project: {
      projectId: "project-1",
      name: "GrantTap",
      canonicalRepositoryId: "sergii-ziborov/granttap-mcp",
      createdAt: 1,
    },
    task: {
      taskId: "task-1",
      projectId: "project-1",
      title: "Pair without Cursor console settings",
      goal: "Keep pairing in the plugin and the app.",
      state: "working",
      createdAt: 1,
      updatedAt: 1,
    },
    peerTasks: [],
    executions: [],
    claims: [{
      claimId: "claim-1",
      projectId: "project-1",
      taskId: "task-1",
      ownerSessionId: "session-1",
      resource: "apps/mcp/src/cursor-config.ts",
      mode: "claim",
      createdAt: 1,
      expiresAt: 2,
    }],
    neighbours: [],
    peers: [],
    otherSide: [{
      taskId: "task-2",
      title: "iOS pairing card",
      repositoryId: "granttap-ios-public",
      via: "api",
      relation: "consumes",
      statedBy: "granttap-mcp",
    }],
    dependencies: [],
    events: [{
      type: "mesh.event",
      sessionId: "task-1",
      eventId: "event-1",
      projectId: "project-1",
      taskId: "task-1",
      sourceSessionId: "session-1",
      eventType: "TASK_PROGRESS",
      createdAt: 1,
      payload: { summary: "Removed the user HTTP MCP entry" },
    }],
    allowedEventTypes: [],
    ...overrides,
  };
}

test("Mesh exposes Cortex library status without an MCP compiler", async () => {
  const packet = await compileMeshContext(view());
  assert.equal(packet.schema, "granttap.mesh-context.v2");
  assert.equal(packet.taskId, "task-1");
  assert.equal(packet.state, "disabled");
  assert.equal(packet.compiler, "cortex-context");
  assert.equal(packet.content, undefined);
});

test("compact context keeps event ids and question text with compiler provenance", async () => {
  const blocked = view({
    events: [{
      type: "mesh.event",
      sessionId: "task-1",
      eventId: "block-1",
      projectId: "project-1",
      taskId: "task-1",
      sourceSessionId: "session-1",
      eventType: "TASK_BLOCKED",
      createdAt: 2,
      payload: { reason: "auth.ts still private", question: "Who owns src/auth.ts?" },
    }],
  });
  const compact = renderCompactProjectContext(blocked);
  assert.equal(compact.schema, "granttap.project-context.compact.v1");
  assert.equal(compact.events[0]?.eventId, "block-1");
  assert.equal(compact.events[0]?.reason, "auth.ts still private");
  assert.equal(compact.events[0]?.question, "Who owns src/auth.ts?");
  assert.equal(compact.repository.worktree, "/tmp/repo");
  assert.equal(compact.expand.full, "granttap://mesh/current?mode=full");
  assert.ok(!("packet" in compact));
  const full = await renderProjectContext(blocked, "full") as { mode: string; events: unknown[] };
  assert.equal(full.mode, "full");
  assert.ok(!("packet" in full));
  const json = JSON.stringify(compact);
  assert.ok(json.length < JSON.stringify(blocked).length);
});

test("broadcast plans a distinct result for each recipient", async () => {
  const planned = planBroadcast([
    { executionId: "offline", canWrite: true, paused: false, online: false },
    { executionId: "paused", canWrite: true, paused: true, online: true },
    { executionId: "reader", canWrite: false, paused: false, online: true },
    { executionId: "writer", canWrite: true, paused: false, online: true },
  ]);
  assert.deepEqual(planned.map((item) => item.state), ["offline", "blocked", "blocked", "queued"]);
  assert.equal(retryable(planned[0]!), true);
  assert.equal(retryable(planned[3]!), false);
  assert.equal(parseProjectContextMode(undefined), "compact");
  assert.equal(parseProjectContextMode("full"), "full");
  const legacy = await renderProjectContext(view(), "legacy") as { mode: string; contextPacket?: unknown };
  assert.equal(legacy.mode, "legacy");
  assert.ok(legacy.contextPacket);
});
