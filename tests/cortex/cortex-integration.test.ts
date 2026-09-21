import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MeshSnapshot } from "../../packages/protocol/schema";
import type { ScopedMeshView } from "../../apps/bridge/src/mesh/snapshot/scoped-view";
import {
  DEFAULT_CORTEX_MAX_TOKENS,
  defaultCortexConfig,
  parseCortexByProject,
} from "../../apps/bridge/src/cortex/config";
import { saveRuntimeConfig } from "../../apps/bridge/src/config/runtime";
import {
  cortexContextForView,
  cortexScopedEvidence,
  cortexSnapshotEvidence,
  projectCortexIntegration,
} from "../../apps/bridge/src/cortex/integration";

function isolate(t: { after: (callback: () => void) => void }): void {
  const root = mkdtempSync(join(tmpdir(), "granttap-cortex-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
}

function snapshot(): MeshSnapshot {
  return {
    type: "mesh.snapshot", sessionId: "project", projectId: "project",
    project: { projectId: "project", name: "GrantTap", canonicalRepositoryId: "repo", createdAt: 1 },
    skills: [{ name: "release", state: "available" }],
    mcpServers: [{
      name: "github", provider: "codex", endpointId: "mac", configuredEnabled: true,
      allowed: true, sessionIds: ["execution"],
    }],
    capabilityRequests: [{ projectId: "project", kind: "skill", name: "qa", requestedAt: 4 }],
    restrictions: {
      projectId: "project", revision: 3, scope: "project",
      rules: [{ ruleId: "lines", kind: "max_file_lines", limit: 300, effect: "deny" }],
      source: "phone",
    },
    backbone: {
      projectId: "project", head: "graph-head",
      nodes: [{ kind: "repository", identity: "repo", displayName: "GrantTap" }],
      relations: [], pendingCandidateCount: 0,
    },
    repositoryGraphs: [{
      projectId: "project", repositoryId: "repo", revision: "content-head",
      weavatrixVersion: "2.17.0", analysisId: "analysis", analysisStatus: "COMPLETE",
      nodes: [], relations: [],
      totalNodes: 0, totalRelations: 0, truncated: false,
    }],
    tasks: [{
      taskId: "task", projectId: "project", title: "Recover Mesh", goal: "Preserve context",
      state: "working", revision: 7, createdAt: 1, updatedAt: 2,
    }],
    executions: [{
      taskId: "task", sessionId: "execution", provider: "codex", computerId: "mac",
      workspace: "/repo", repositoryId: "repo", startedAt: 1,
    }],
    claims: [], dependencies: [],
    events: [{
      type: "mesh.event", sessionId: "task", eventId: "event", projectId: "project",
      taskId: "task", sourceSessionId: "execution", eventType: "TASK_PROGRESS",
      createdAt: 3, payload: { summary: "Started" },
    }],
    generatedAt: 5,
  };
}

function view(value: MeshSnapshot): ScopedMeshView {
  return {
    schema: "granttap.mesh-scope.v1", generatedAt: value.generatedAt,
    execution: value.executions[0]!, project: value.project, task: value.tasks[0]!,
    peerTasks: [], executions: value.executions, claims: [], neighbours: [],
    backbone: value.backbone, repositoryGraphs: value.repositoryGraphs,
    peers: [], skills: value.skills, mcpServers: value.mcpServers,
    capabilityRequests: value.capabilityRequests, otherSide: [], dependencies: [],
    events: value.events, allowedEventTypes: [], restrictions: value.restrictions,
  };
}

test("Cortex configuration is Project-owned library configuration", () => {
  assert.deepEqual(defaultCortexConfig(), {
    enabled: false,
    maxTokens: DEFAULT_CORTEX_MAX_TOKENS,
  });
  assert.deepEqual(parseCortexByProject({
    project: { enabled: true, maxTokens: 8_192 },
    disabled: { enabled: false, maxTokens: 512 },
    invalid: { enabled: true, maxTokens: 1 },
    ["x".repeat(129)]: { enabled: true, maxTokens: 1_024 },
  }), {
    project: { enabled: true, maxTokens: 8_192 },
    disabled: { enabled: false, maxTokens: 512 },
  });
});

test("legacy server fields do not make Cortex an HTTP or MCP dependency", () => {
  assert.deepEqual(parseCortexByProject({
    project: {
      enabled: true,
      maxTokens: 4_096,
      endpointUrl: "https://old-cortex.example.test",
      graphId: "legacy",
    },
  }), { project: { enabled: true, maxTokens: 4_096 } });
});

test("Cortex evidence keeps Project heads, policy, memory, and capability identity", () => {
  const value = snapshot();
  const fromSnapshot = cortexSnapshotEvidence(value, "task");
  assert.deepEqual(fromSnapshot.map((item) => item.id), [
    "task.goal", "project.restrictions", "project.backbone", "repository.repo", "event.event",
  ]);
  assert.equal(fromSnapshot[0]?.snapshot_id, "task:7");
  assert.equal(fromSnapshot[1]?.snapshot_id, "policy:3");
  assert.equal(fromSnapshot[2]?.state, "unverified", "a Backbone summary can contain declared relations");
  assert.equal(fromSnapshot[3]?.snapshot_id, "content-head");
  const unavailable = { ...value, repositoryGraphs: [{
    ...value.repositoryGraphs![0]!, revision: "unverified", weavatrixVersion: "unknown",
    analysisId: undefined, analysisStatus: "UNAVAILABLE" as const,
    analysisErrorCode: "REPOSITORY_IDENTITY_MISMATCH", nodes: [], relations: [],
    totalNodes: 0, totalRelations: 0,
  }] };
  assert.equal(cortexSnapshotEvidence(unavailable, "task")
    .some((item) => item.id === "repository.repo"), false);
  assert.equal(cortexScopedEvidence(view(unavailable))
    .some((item) => item.id === "repository.repo"), false);

  const scoped = cortexScopedEvidence(view(value));
  assert.deepEqual(scoped.slice(-3).map((item) => item.id), [
    "project.skills", "project.mcp", "project.capability_requests",
  ]);
  assert.deepEqual(scoped.slice(-3).map((item) => item.state), [
    "unverified", "unverified", "unverified",
  ]);
  assert.equal(cortexSnapshotEvidence({ ...value, tasks: [], events: [] }, "missing").length, 3);
  const empty = view({ ...value, tasks: [], events: [], backbone: undefined, repositoryGraphs: [] });
  empty.task = null;
  empty.skills = [];
  empty.mcpServers = [];
  empty.capabilityRequests = [];
  empty.restrictions = undefined;
  assert.equal(cortexScopedEvidence(empty)[0]?.id, "task.identity");
});

test("Project Cortex reports disabled, unavailable, loaded, degraded, and succeeded states", async (t) => {
  isolate(t);
  const value = snapshot();
  assert.equal((await projectCortexIntegration(value, "mac", { now: () => 10 })).state, "disabled");
  const disabled = await projectCortexIntegration(value, "mac", {
    provenance: async () => ({
      engineVersion: "0.1.0", cortexVersion: "0.1.0", cortexRevision: "revision",
      weavatrixVersion: "2.17.0",
    }), now: () => 10,
  });
  assert.equal(disabled.weavatrixVersion, "2.17.0",
    "turning Cortex off for this Project must not hide the loaded Weavatrix build");

  saveRuntimeConfig({ cortexByProject: { project: { enabled: true, maxTokens: 4_096 } } });
  assert.equal((await projectCortexIntegration(value, "mac", {
    provenance: async () => undefined, now: () => 11,
  })).state, "unavailable");
  const provenance = async () => ({
    engineVersion: "0.1.0", cortexVersion: "0.1.0", cortexRevision: "revision",
    weavatrixVersion: "2.17.0",
  });
  assert.equal((await projectCortexIntegration({ ...value, tasks: [] }, "mac", {
    provenance, now: () => 12,
  })).state, "loaded");
  assert.equal((await projectCortexIntegration(value, "mac", {
    provenance, compile: async () => undefined, now: () => 13,
  })).detail, "Cortex context compilation failed");

  const compile = async () => ({
    project_id: "project", task_id: "task", cortex_version: "0.1.0", cortex_revision: "revision",
    packet: {
      content: "context", included_ids: ["task.goal"], omitted_ids: ["event.event"],
      raw_estimated_tokens: 8, selected_estimated_tokens: 4, omitted_estimated_tokens: 4,
      requires_upstream: true, deduplicated_lines: 1, deduplicated_estimated_tokens: 2,
      packet_id: "packet", snapshot_id: "snapshot",
    },
  });
  const degraded = await projectCortexIntegration(value, "mac", { provenance, compile, now: () => 14 });
  assert.equal(degraded.state, "degraded");
  assert.deepEqual(degraded.packet, {
    packetId: "packet", snapshotId: "snapshot", included: 1, omitted: 1,
    rawEstimatedTokens: 8, selectedEstimatedTokens: 4, omittedEstimatedTokens: 4,
    deduplicatedLines: 1, requiresUpstream: true,
  });
  const succeeded = await projectCortexIntegration(value, "mac", {
    provenance,
    compile: async (input) => ({ ...await compile(), packet: { ...(await compile()).packet, requires_upstream: false } }),
  });
  assert.equal(succeeded.state, "succeeded");
  const noRepositoryReport = await projectCortexIntegration({
    ...value, bindings: [{
      bindingId: "mac-repo", projectId: "project", endpointId: "mac",
      repositoryId: "repo", displayName: "GrantTap", available: true,
    }], repositoryGraphs: [],
  }, "mac", {
    provenance,
    compile: async () => ({ ...await compile(), packet: {
      ...(await compile()).packet, requires_upstream: false,
    } }),
  });
  assert.equal(noRepositoryReport.state, "degraded");
  assert.equal(noRepositoryReport.detail, "Weavatrix repository analysis pending or unavailable");
  let targetedRepository: string | undefined;
  await projectCortexIntegration({
    ...value, bindings: [{
      bindingId: "mac-repo", projectId: "project", endpointId: "mac",
      repositoryId: "repo", displayName: "GrantTap", available: true,
    }],
  }, "mac", {
    provenance,
    compile: async (input) => {
      targetedRepository = input.targetRepositoryId;
      return { ...await compile(), packet: { ...(await compile()).packet, requires_upstream: false } };
    },
  });
  assert.equal(targetedRepository, "repo");
  const brokenRepositoryReport = await projectCortexIntegration({
    ...value, bindings: [{
      bindingId: "mac-repo", projectId: "project", endpointId: "mac",
      repositoryId: "repo", displayName: "GrantTap", available: true,
    }], repositoryGraphs: [{
      ...value.repositoryGraphs![0]!, analysisStatus: "UNAVAILABLE",
      analysisErrorCode: "REPOSITORY_IDENTITY_MISMATCH", nodes: [], relations: [],
      totalNodes: 0, totalRelations: 0,
    }],
  }, "mac", {
    provenance, compile: async () => ({ ...await compile(), packet: {
      ...(await compile()).packet, requires_upstream: false,
    } }),
  });
  assert.equal(brokenRepositoryReport.state, "degraded");
  const partialRepositoryReport = await projectCortexIntegration({
    ...value, repositoryGraphs: [{ ...value.repositoryGraphs![0]!, analysisStatus: "INCOMPLETE" }],
  }, "mac", {
    provenance, compile: async () => ({ ...await compile(), packet: {
      ...(await compile()).packet, requires_upstream: false,
    } }),
  });
  assert.equal(partialRepositoryReport.state, "degraded");
});

test("a scoped generic client receives the same Cortex compilation input", async (t) => {
  isolate(t);
  const value = snapshot();
  const scoped = view(value);
  assert.equal(await cortexContextForView(scoped), undefined);
  saveRuntimeConfig({ cortexByProject: { project: { enabled: true, maxTokens: 2_048 } } });
  let received = 0;
  let targetedRepository: string | undefined;
  const compiled = await cortexContextForView(scoped, { compile: async (input) => {
    received = input.evidence.length;
    targetedRepository = input.targetRepositoryId;
    return undefined;
  } });
  assert.equal(compiled, undefined);
  assert.ok(received >= 8);
  assert.equal(targetedRepository, "repo");
});
