import assert from "node:assert/strict";
import test from "node:test";
import { MeshSnapshot } from "../../../packages/protocol/schema";
import { projectCapabilityObservations } from "../../../apps/bridge/src/mesh/catalog/project/observations";

test("each bound computer reports its own result for the same Project request", () => {
  const request = {
    projectId: "project", requestId: "one", kind: "skill" as const,
    name: "review", artifactDigest: "a".repeat(64), requestedAt: 1,
  };
  const input = {
    projectId: "project", bound: true, requests: [request], mcpServers: [], now: 2,
  };
  const ready = projectCapabilityObservations({
    ...input, endpointId: "mac-a",
    skills: [{ name: "review", endpointId: "mac-a", digest: "a".repeat(64), state: "discovered" }],
  });
  const conflicting = projectCapabilityObservations({
    ...input, endpointId: "mac-b",
    skills: [{ name: "review", endpointId: "mac-b", digest: "b".repeat(64), state: "discovered" }],
  });
  const offline = projectCapabilityObservations({
    ...input, endpointId: "mac-c", bound: false, skills: [],
  });
  assert.deepEqual([ready[0]?.state, conflicting[0]?.state, offline[0]?.state],
    ["discovered", "version_conflict", "needs_binding"]);
  assert.equal(ready[0]?.requestId, "one");
  assert.equal(conflicting[0]?.endpointId, "mac-b");
  assert.equal(MeshSnapshot.safeParse({
    type: "mesh.snapshot", sessionId: "project", projectId: "project",
    project: { projectId: "project", name: "Project", canonicalRepositoryId: "repo", createdAt: 1 },
    tasks: [], executions: [], claims: [], dependencies: [], events: [],
    capabilityRequests: [request], capabilityObservations: ready, generatedAt: 2,
  }).success, true);
});

test("MCP configuration, initialization, and missing credentials remain distinct", () => {
  const request = { projectId: "project", requestId: "mcp-1", kind: "mcp" as const,
    name: "github", requestedAt: 1 };
  const base = { projectId: "project", endpointId: "mac", bound: true,
    requests: [request], skills: [], now: 2 };
  const server = { name: "github", provider: "codex" as const, endpointId: "mac",
    configuredEnabled: true, allowed: true, sessionIds: [] };
  const state = (mcpServers: Array<typeof server & { metadataSource?: "mcp"; authStatus?: string }>) =>
    projectCapabilityObservations({ ...base, mcpServers })[0]?.state;
  assert.equal(state([server]), "configured");
  assert.equal(state([{ ...server, metadataSource: "mcp" }]), "initialized");
  assert.equal(state([{ ...server, authStatus: "not_authenticated" }]), "credential_missing");
  assert.equal(state([]), "not_found");
});
