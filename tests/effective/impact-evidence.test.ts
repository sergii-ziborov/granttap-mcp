import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifiedImpactAvailable } from "../../apps/bridge/src/policy/impact/impact-evidence";
import { evaluateEffectiveAction } from "../../apps/bridge/src/policy/effective-action";
import { inspectRepository } from "../../apps/bridge/src/mesh/catalog";
import { localMeshStore, resetLocalMeshStore } from "../../apps/bridge/src/mesh/local-remote/local";
import { parseEngineResponse } from "../../apps/bridge/src/engine/protocol/engine-protocol";
import type { EngineClientLike } from "../../apps/bridge/src/engine/runtime/engine-supervisor";

const scope = {
  projectId: "project-a", taskId: "task-a", repositoryId: "repo-a",
  repositoryRevision: "revision-a", path: "src/file.ts",
};

function client(taskHead = "head-a", revision = "revision-a", completeness = "complete"):
  EngineClientLike {
  return {
    async request(operation) {
      if (operation.operation === "graph.get_heads") return {
        operation: "graph.heads",
        heads: {
          project_id: "project-a", project_backbone_head: null,
          task_graph_heads: [{ task_id: "task-a", head: "head-a" }],
          repo_revisions: [{ repository_id: "repo-a", revision }],
        },
      };
      if (operation.operation === "graph.compute_impact") {
        assert.equal(operation.input.max_results, 256);
        return {
        operation: "graph.impact",
        impact: {
          task_graph_head: taskHead, completeness: completeness as "complete" | "partial",
          affected_roots: ["repo:repo-a", "file:repo-a:src/file.ts"],
          repositories: ["repo-a"], files: ["src/file.ts"],
          related_files: [], unresolved: [],
        },
        };
      }
      throw new Error("unexpected operation");
    },
    close() {},
  };
}

test("impact is available only for an exact complete Task and repository revision", async () => {
  assert.equal(await verifiedImpactAvailable(client(), scope, 2_000, () => 1), true);
  assert.equal(await verifiedImpactAvailable(client("stale"), scope, 2_000, () => 1), false);
  assert.equal(await verifiedImpactAvailable(client("head-a", "old"), scope, 2_000, () => 1), false);
  assert.equal(await verifiedImpactAvailable(client("head-a", "revision-a", "partial"),
    scope, 2_000, () => 1), false);
});

test("graph evidence wire rejects malformed and unbounded data", () => {
  const envelope = (result: unknown) => ({
    protocol_version: 1, request_id: "r", status: "ok", result,
  });
  const heads = {
    operation: "graph.heads", heads: {
      project_id: "project-a", project_backbone_head: null,
      task_graph_heads: [{ task_id: "task-a", head: "head-a" }],
      repo_revisions: [{ repository_id: "repo-a", revision: "revision-a" }],
    },
  };
  assert.equal(parseEngineResponse(envelope(heads), "r").operation, "graph.heads");
  assert.throws(() => parseEngineResponse(envelope({
    ...heads, heads: { ...heads.heads, repo_revisions: [{ repository_id: "repo-a" }] },
  }), "r"), /graph result is invalid/);
  assert.throws(() => parseEngineResponse(envelope({
    operation: "graph.impact", impact: {
      task_graph_head: "head-a", completeness: "unknown", affected_roots: [],
      repositories: [], files: [], related_files: [], unresolved: [],
    },
  }), "r"), /graph result is invalid/);
});

test("a bound Task write sends verified impact availability into policy", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "granttap-impact-policy-"));
  const prior = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = directory;
  resetLocalMeshStore();
  t.after(() => {
    resetLocalMeshStore();
    if (prior == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = prior;
    rmSync(directory, { recursive: true, force: true });
  });
  const cwd = process.cwd();
  const repository = inspectRepository(cwd);
  assert.ok(repository.revision);
  const store = localMeshStore();
  const at = Date.now();
  store.upsertProject({
    projectId: "project-a", name: "Project", repositoryRoot: cwd,
    canonicalRepositoryId: repository.canonicalRepositoryId, createdAt: at,
  });
  store.upsertTask({
    taskId: "task-a", projectId: "project-a", title: "Task", goal: "Edit",
    state: "working", ownerSessionId: "session-a", createdAt: at, updatedAt: at,
  });
  store.linkExecution({
    taskId: "task-a", sessionId: "session-a", provider: "claude", computerId: "mac",
    workspace: cwd, startedAt: at,
  });
  let available: boolean | undefined;
  const engine: EngineClientLike = {
    async request(operation) {
      if (operation.operation === "graph.get_heads") return {
        operation: "graph.heads", heads: {
          project_id: "project-a", project_backbone_head: null,
          task_graph_heads: [{ task_id: "task-a", head: "head-a" }],
          repo_revisions: [{ repository_id: repository.canonicalRepositoryId,
            revision: repository.revision! }],
        },
      };
      if (operation.operation === "graph.compute_impact") return {
        operation: "graph.impact", impact: {
          task_graph_head: "head-a", completeness: "complete",
          affected_roots: [`file:${repository.canonicalRepositoryId}:src/file.ts`],
          repositories: [repository.canonicalRepositoryId], files: ["src/file.ts"],
          related_files: [], unresolved: [],
        },
      };
      if (operation.operation === "policy.evaluate_action") {
        available = operation.input.impact_available;
        return { operation: "policy.evaluated", decision: {
          effect: "allow", source: "project", reason: "Impact is verified",
        } };
      }
      throw new Error("unexpected operation");
    },
    close() {},
  };
  const decision = await evaluateEffectiveAction({
    provider: "claude", sessionId: "session-a", cwd,
    toolName: "Write", toolInput: { file_path: "src/file.ts", content: "const value = 1;" },
  }, {
    env: { GRANTTAP_ENGINE_ENABLED: "1", GRANTTAP_PROJECT_POLICY_ENABLED: "1" },
    projectId: "project-a", endpointId: "mac", client: engine,
  });
  assert.equal(decision.effect, "allow");
  assert.equal(available, true);
});
