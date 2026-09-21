import assert from "node:assert/strict";
import test from "node:test";
import {
  compileProjectContext, projectBackbone, projectEngineProvenance,
  projectRepositoryGraphs, syncProjectBinding,
} from "../../apps/bridge/src/engine/runtime/engine-projects";
import type { EngineClientLike } from "../../apps/bridge/src/engine/runtime/engine-supervisor";
import type { EngineOperation, EngineResult } from "../../apps/bridge/src/engine/protocol/engine-protocol";

const project = {
  projectId: "applydjinn",
  name: "ApplyDjinn",
  canonicalRepositoryId: "github.com/example/frontend",
  createdAt: 1_800_000_000_000,
};

const local = {
  summary: {
    bindingId: "mac-frontend",
    projectId: "applydjinn",
    endpointId: "macbook",
    repositoryId: "github.com/example/frontend",
    displayName: "Frontend",
    available: true,
    revision: "a".repeat(40),
  },
  localRoot: "/work/frontend",
  canonicalRemote: "https://token@github.com/example/frontend?secret=yes",
  lastSeenAt: 1_800_000_000_100,
} as const;

test("disabled Project engine receives no binding record", async () => {
  let calls = 0;
  const client = fakeClient(async () => {
    calls += 1;
    throw new Error("must not run");
  });
  assert.equal(await syncProjectBinding(project, local, { env: {}, client }), false);
  assert.equal(calls, 0);
});

test("enabled Project sync sends local detail only through engine IPC", async () => {
  let operation: EngineOperation | undefined;
  const client = fakeClient(async (input) => {
    operation = input;
    if (input.operation !== "project.upsert_binding") throw new Error("unexpected operation");
    return { operation: "project.binding_upserted", binding: input.input.binding };
  });
  assert.equal(await syncProjectBinding(project, local, {
    env: { GRANTTAP_ENGINE_ENABLED: "1" }, client,
  }), true);
  assert.equal(operation?.operation, "project.upsert_binding");
  if (operation?.operation !== "project.upsert_binding") assert.fail("binding operation required");
  assert.equal(operation.input.binding.local_root, "/work/frontend");
  assert.equal(operation.input.binding.canonical_remote, "github.com/example/frontend");
  assert.equal(operation.input.project.name, "ApplyDjinn");
});

test("Project binding sync preserves legacy behavior when IPC fails", async () => {
  const client = fakeClient(async () => { throw new Error("offline"); });
  assert.equal(await syncProjectBinding(project, local, {
    env: { GRANTTAP_ENGINE_ENABLED: "true" }, client,
  }), false);
});

test("Project Backbone maps the Rust wire result without repository contents", async () => {
  const client = fakeClient(async (input) => {
    assert.deepEqual(input, { operation: "graph.get_backbone", input: { project_id: "applydjinn" } });
    return {
      operation: "graph.backbone",
      backbone: {
        project_id: "applydjinn", head: "a".repeat(64), pending_candidate_count: 1,
        nodes: [{ kind: "repository", identity: "frontend", display_name: "Frontend" }],
        relations: [{
          source: "frontend", target: "api", relation: "owns", evidence_count: 2,
        }],
      },
    };
  });
  const backbone = await projectBackbone("applydjinn", {
    env: { GRANTTAP_ENGINE_ENABLED: "1" }, client,
  });
  assert.equal(backbone?.nodes[0]?.displayName, "Frontend");
  assert.equal(backbone?.relations[0]?.evidenceCount, 2);
  assert.equal(backbone?.pendingCandidateCount, 1);
});

test("Engine provenance names linked Cortex and Weavatrix library builds", async () => {
  const client = fakeClient(async (input) => {
    assert.deepEqual(input, { operation: "engine.version" });
    return {
      operation: "engine.version", engine_version: "0.1.0", protocol_version: 1,
      cortex_version: "0.1.0", cortex_revision: "a".repeat(40),
      weavatrix_version: "2.17.0",
    };
  });
  assert.deepEqual(await projectEngineProvenance({
    env: { GRANTTAP_ENGINE_ENABLED: "1" }, client,
  }), {
    engineVersion: "0.1.0", cortexVersion: "0.1.0",
    cortexRevision: "a".repeat(40), weavatrixVersion: "2.17.0",
  });
});

test("Project context calls the linked Cortex Engine operation", async () => {
  const client = fakeClient(async (input) => {
    if (input.operation !== "context.compile_project") throw new Error("unexpected operation");
    return { operation: "context.compiled", compilation: {
      project_id: input.input.project_id, task_id: input.input.task_id,
      cortex_version: "0.1.0", cortex_revision: "a".repeat(40),
      packet: {
        content: "compiled", included_ids: ["goal"], omitted_ids: [],
        raw_estimated_tokens: 2, selected_estimated_tokens: 2,
        omitted_estimated_tokens: 0, requires_upstream: true,
        deduplicated_lines: 0, deduplicated_estimated_tokens: 0,
      },
    } };
  });
  const compiled = await compileProjectContext({
    projectId: "applydjinn", taskId: "task", maxTokens: 512,
    evidence: [{
      id: "goal", source: "project.task", content: "Ship", priority: "critical",
      state: "unverified", derivation: "plan",
    }],
  }, { env: { GRANTTAP_ENGINE_ENABLED: "1" }, client });
  assert.equal(compiled?.packet.content, "compiled");
  assert.equal(compiled?.cortex_revision, "a".repeat(40));
});

test("repository graph maps full Weavatrix analysis for each unique binding", async () => {
  const client = fakeClient(async (input) => {
    if (input.operation !== "graph.analyze_repository") throw new Error("unexpected operation");
    return {
      operation: "graph.repository",
      graph: {
        project_id: input.input.project_id,
        repository_id: input.input.repository_id,
        revision: "revision", weavatrix_version: "2.17.1",
        analysis_id: "a".repeat(64), analysis_status: "COMPLETE",
        nodes: [{ id: "src", kind: "component", label: "src" }],
        relations: [], total_nodes: 1, total_relations: 0, truncated: false,
      },
    };
  });
  const graphs = await projectRepositoryGraphs("applydjinn", [local.summary, local.summary], {
    env: { GRANTTAP_ENGINE_ENABLED: "1" }, client,
  });
  assert.equal(graphs.length, 1);
  assert.equal(graphs[0]?.repositoryId, local.summary.repositoryId);
  assert.equal(graphs[0]?.weavatrixVersion, "2.17.1");
  assert.equal(graphs[0]?.analysisStatus, "COMPLETE");
  assert.equal(graphs[0]?.nodes[0]?.kind, "component");
});

test("repository graphs stay inside the Mesh snapshot wire budget", async () => {
  const nodes = Array.from({ length: 256 }, (_, index) => ({
    id: `node-${index}-${"x".repeat(180)}`, kind: "module", label: `Module ${index} ${"y".repeat(120)}`,
  }));
  const relations = Array.from({ length: 512 }, (_, index) => ({
    source: nodes[index % nodes.length]!.id,
    target: nodes[(index + 1) % nodes.length]!.id,
    relation: "contains",
  }));
  const client = fakeClient(async (input) => {
    if (input.operation !== "graph.analyze_repository") throw new Error("unexpected operation");
    return { operation: "graph.repository", graph: {
      project_id: input.input.project_id, repository_id: input.input.repository_id,
      revision: "revision", weavatrix_version: "2.17.0", nodes, relations,
      total_nodes: nodes.length, total_relations: relations.length, truncated: false,
    } };
  });
  const bindings = Array.from({ length: 4 }, (_, index) => ({
    ...local.summary, bindingId: `binding-${index}`, repositoryId: `repository-${index}`,
  }));
  const graphs = await projectRepositoryGraphs("applydjinn", bindings, {
    env: { GRANTTAP_ENGINE_ENABLED: "1" }, client,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(graphs), "utf8") <= 128 * 1_024);
  assert.ok(graphs.length > 0);
  assert.ok(graphs.every((graph) => graph.truncated));
});

function fakeClient(
  request: (operation: EngineOperation) => Promise<EngineResult>,
): EngineClientLike {
  return { request, close: () => undefined };
}
