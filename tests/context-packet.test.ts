import assert from "node:assert/strict";
import test from "node:test";
import { compileMeshContext } from "../apps/bridge/src/mesh/context-packet";
import type { ScopedMeshView } from "../apps/bridge/src/mesh/scoped-view";

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

test("Mesh compiles its own bounded packet without an MCP compiler", () => {
  const packet = compileMeshContext(view());
  assert.equal(packet.schema, "granttap.mesh-context.v1");
  assert.equal(packet.taskId, "task-1");
  assert.equal(packet.title, "Pair without Cursor console settings");
  assert.equal(packet.state, "working");
  assert.deepEqual(packet.claims, ["apps/mcp/src/cursor-config.ts"]);
  assert.deepEqual(packet.events, ["TASK_PROGRESS: Removed the user HTTP MCP entry"]);
  assert.deepEqual(packet.otherSide, ["granttap-ios-public iOS pairing card"]);
});
