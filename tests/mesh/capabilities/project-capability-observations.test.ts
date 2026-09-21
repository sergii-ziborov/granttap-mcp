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

test("one initialized provider does not certify another provider with the same MCP name", () => {
  const base = { name: "weavatrix", endpointId: "mac",
    configuredEnabled: true, allowed: true, sessionIds: [] };
  const request = { projectId: "project", requestId: "weavatrix-1", kind: "mcp" as const,
    name: "weavatrix", requestedAt: 1 };
  const observe = (mcpServers: Array<typeof base & {
    provider: "codex" | "cursor"; metadataSource?: "mcp"; version?: string;
  }>) => projectCapabilityObservations({
    projectId: "project", endpointId: "mac", bound: true, requests: [request],
    skills: [], mcpServers, now: 2,
  })[0];
  assert.equal(observe([
    { ...base, provider: "codex", metadataSource: "mcp", version: "2" },
    { ...base, provider: "cursor", version: "2" },
  ])?.state, "configured");
  assert.equal(observe([
    { ...base, provider: "codex", metadataSource: "mcp", version: "2" },
    { ...base, provider: "cursor", metadataSource: "mcp", version: "3" },
  ])?.state, "version_conflict");
});

test("a pinned MCP request requires the exact reported configuration digest", () => {
  const digest = "a".repeat(64);
  const server = { name: "review", provider: "cursor" as const, endpointId: "mac",
    configuredEnabled: true, allowed: true, sessionIds: [] };
  const input = { projectId: "project", endpointId: "mac", bound: true,
    requests: [{ projectId: "project", requestId: "pinned", kind: "mcp" as const,
      name: "review", artifactDigest: digest, requestedAt: 1 }],
    skills: [], now: 2 };
  const observe = (configDigest?: string) => projectCapabilityObservations({
    ...input, mcpServers: [{ ...server, configDigest }],
  })[0]?.state;
  assert.equal(observe(digest), "configured");
  assert.equal(observe("b".repeat(64)), "version_conflict");
  assert.equal(observe(), "unsupported");
  const selected = projectCapabilityObservations({
    ...input, mcpServers: [
      { ...server, configDigest: digest },
      { ...server, provider: "codex", configDigest: "b".repeat(64),
        metadataSource: "mcp", authStatus: "credential_missing" },
    ],
  });
  assert.equal(selected[0]?.state, "configured");
  assert.equal(selected[0]?.artifactDigest, digest);
});

test("MCP result reports the observed native digest even when a pin differs", () => {
  const observed = "c".repeat(64);
  const result = projectCapabilityObservations({
    projectId: "project", endpointId: "mac", bound: true,
    requests: [{ projectId: "project", requestId: "pinned", kind: "mcp",
      name: "review", artifactDigest: "a".repeat(64), requestedAt: 1 }],
    skills: [], now: 2,
    mcpServers: [{ name: "review", provider: "codex", endpointId: "mac",
      configuredEnabled: true, allowed: true, configDigest: observed, sessionIds: [] }],
  });
  assert.equal(result[0]?.state, "version_conflict");
  assert.equal(result[0]?.artifactDigest, observed);
});

test("an unpinned MCP name cannot certify different native implementations", () => {
  const base = { name: "weavatrix", endpointId: "mac",
    configuredEnabled: true, allowed: true, sessionIds: [] };
  const request = { projectId: "project", requestId: "unpinned", kind: "mcp" as const,
    name: "weavatrix", requestedAt: 1 };
  const state = (first?: string, second?: string) => projectCapabilityObservations({
    projectId: "project", endpointId: "mac", bound: true, requests: [request],
    skills: [], now: 2, mcpServers: [
      { ...base, provider: "codex" as const, configDigest: first },
      { ...base, provider: "cursor" as const, configDigest: second },
    ],
  })[0]?.state;
  assert.equal(state("a".repeat(64), "b".repeat(64)), "version_conflict");
  assert.equal(state("a".repeat(64), undefined), "unsupported");
  assert.equal(state("a".repeat(64), "a".repeat(64)), "configured");
});
