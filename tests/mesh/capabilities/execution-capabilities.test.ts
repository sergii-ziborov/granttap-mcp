import assert from "node:assert/strict";
import test from "node:test";
import type { MeshSnapshot, SessionInfo } from "../../../packages/protocol/schema";
import { projectExecutionCapabilitySessions } from "../../../apps/bridge/src/mesh/runtime/capabilities/execution-capabilities";

const localSession: SessionInfo = {
  sessionId: "shared-native-id", agent: "codex", state: "idle",
  startedAt: 1, lastActivityAt: 2, tokensSession: 0, tokensLastTurn: 0,
};

test("native capability inventory is attributed only to an exact local execution", () => {
  const snapshot = {
    projectId: "project-a",
    executions: [
      { sessionId: "shared-native-id", provider: "codex", computerId: "local", workspace: "/repo" },
      { sessionId: "shared-native-id", provider: "claude", computerId: "remote" },
    ],
  } as MeshSnapshot;
  const linked = projectExecutionCapabilitySessions(snapshot, [
    { ...localSession, cwd: "/repo" },
    { ...localSession, agent: "claude" },
    { ...localSession, projectId: "project-b" },
    { ...localSession, cwd: "/other" },
  ], "local", (session) => ({
    ...session, mcpServers: [{ name: "configured", configuredEnabled: true, allowed: true }],
  }));
  assert.equal(linked.length, 1);
  assert.equal(linked[0]?.projectId, "project-a");
  assert.equal(linked[0]?.computerId, "local");
  assert.equal(linked[0]?.mcpServers?.[0]?.name, "configured");
});
