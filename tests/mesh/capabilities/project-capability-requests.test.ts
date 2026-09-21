import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Payload } from "../../../packages/protocol/schema";
import {
  loadProjectCapabilityRequests,
  saveProjectCapabilityRequest,
} from "../../../apps/bridge/src/mesh/catalog/project/requests";
import { projectMcpServers } from "../../../apps/bridge/src/mesh/catalog/project/capabilities";
import type { SessionInfo } from "../../../packages/protocol/schema";

function isolated(t: { after: (fn: () => void) => void }): void {
  const root = mkdtempSync(join(tmpdir(), "granttap-capability-request-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
}

test("a Project capability request is scoped, durable, and converges by identity", (t) => {
  isolated(t);
  const wire = Payload.parse({
    type: "project.capability.request", sessionId: "project", requestId: "request-1",
    projectId: "project", kind: "skill", name: "release", source: "owner/repo",
    version: "1.2.0", requestedAt: 10,
  });
  assert.equal(wire.type, "project.capability.request");
  if (wire.type !== "project.capability.request") return;
  saveProjectCapabilityRequest(wire);
  saveProjectCapabilityRequest({ ...wire, requestId: "older", name: "RELEASE",
    version: "1.1.0", requestedAt: 9 });
  saveProjectCapabilityRequest({ ...wire, requestId: "mcp", kind: "mcp",
    name: "github", requestedAt: 11 });
  const stored = loadProjectCapabilityRequests();
  assert.equal(stored.length, 2);
  assert.equal(stored.find((item) => item.kind === "skill")?.version, "1.2.0");
  assert.equal(stored.find((item) => item.kind === "skill")?.requestId, "request-1");
  assert.throws(() => saveProjectCapabilityRequest({ ...wire, version: "2.0.0" }),
    /request ID reused/);
  assert.throws(() => Payload.parse({ ...wire, sessionId: "other" }));
});

test("Project MCP inventory reflects observed endpoint sessions and never promotes a request", () => {
  const session = (
    sessionId: string, input: Partial<SessionInfo> = {},
  ): SessionInfo => ({
    sessionId, agent: "codex", projectId: "project", computerId: "mac-a",
    state: "idle", startedAt: 1, lastActivityAt: 2, tokensSession: 0, tokensLastTurn: 0,
    ...input,
  });
  const sessions = [
    session("native-a", { mcpServers: [{
      name: "github", configuredEnabled: false, allowed: false,
    }] }),
    session("native-b", { projectId: undefined, mcpServers: [{
      name: "github", configuredEnabled: true, allowed: true,
      title: "GitHub", authStatus: "ready", version: "2.4.0", metadataSource: "mcp",
    }] }),
    session("native-c", { mcpServers: [{
      name: "github", configuredEnabled: true, allowed: true,
    }] }),
    session("foreign", { projectId: "other", computerId: "mac-b", mcpServers: [{
      name: "github", configuredEnabled: true, allowed: true,
    }] }),
    session("no-host", { computerId: undefined, mcpServers: [{
      name: "local-only", configuredEnabled: true, allowed: true,
    }] }),
    session("no-provider", { agent: "unknown", mcpServers: [{
      name: "unknown", configuredEnabled: true, allowed: true,
    }] }),
    session("other-provider", { agent: "claude", mcpServers: [{
      name: "github", configuredEnabled: true, allowed: false,
    }] }),
    session("other-host", { computerId: "mac-b", mcpServers: [{
      name: "github", configuredEnabled: true, allowed: true,
    }] }),
  ];
  const inventory = projectMcpServers(sessions, "project");
  assert.equal(inventory.length, 3);
  assert.deepEqual(inventory[0], {
    name: "github", provider: "claude", endpointId: "mac-a",
    configuredEnabled: true, allowed: false, authStatus: undefined,
    title: undefined, version: undefined, metadataSource: undefined,
    sessionIds: ["other-provider"],
  });
  assert.deepEqual(inventory[1], {
    name: "github", provider: "codex", endpointId: "mac-a",
    configuredEnabled: false, allowed: false, authStatus: undefined,
    title: undefined, version: undefined, metadataSource: undefined,
    sessionIds: ["native-a", "native-c"],
  });
  assert.equal(inventory[2]?.endpointId, "mac-b");
  assert.equal(inventory.some((row) => row.sessionIds.includes("native-b")), false);
  assert.equal(Payload.safeParse({
    type: "mesh.snapshot", sessionId: "project", projectId: "project",
    project: { projectId: "project", name: "P", canonicalRepositoryId: "repo", createdAt: 1 },
    tasks: [], executions: [], claims: [], dependencies: [], events: [],
    mcpServers: [inventory[0]], generatedAt: 1,
  }).success, true);
  assert.deepEqual(projectMcpServers([session("empty")], "project"), []);
});
