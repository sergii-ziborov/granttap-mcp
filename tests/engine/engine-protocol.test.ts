import assert from "node:assert/strict";
import test from "node:test";
import {
  EngineFrameDecoder,
  EngineProtocolError,
  EngineRemoteError,
  MAX_ENGINE_FRAME_BYTES,
  encodeEngineFrame,
  parseEngineResponse,
} from "../../apps/bridge/src/engine/protocol/engine-protocol";

const response = (result: unknown) => ({
  protocol_version: 1,
  request_id: "request-1",
  status: "ok",
  result,
});

test("response parser accepts every Rust v1 result", () => {
  const results = [
    { operation: "engine.pong", engine_version: "0.1.0" },
    {
      operation: "engine.version", engine_version: "0.1.0", protocol_version: 1,
      cortex_version: "0.1.0", cortex_revision: "a".repeat(40),
      weavatrix_version: "2.17.0",
    },
    {
      operation: "project.resolved",
      resolution: { project_id: "project", compatibility_mode: false },
    },
    {
      operation: "project.found",
      project: { project_id: "project", name: "Project", created_at: 1 },
    },
    {
      operation: "project.bindings",
      bindings: [{
        binding_id: "binding", project_id: "project", endpoint_id: "mac",
        repository_id: "repo", local_root: "/repo", local_alias: "Repo",
        canonical_remote: "github.com/example/repo", role: "primary",
        observed_revision: "a".repeat(40), last_seen_at: 1,
      }],
    },
    {
      operation: "project.binding_upserted",
      binding: {
        binding_id: "binding", project_id: "project", endpoint_id: "mac",
        repository_id: "repo", local_root: null, local_alias: null,
        canonical_remote: null, role: "dependency", observed_revision: null, last_seen_at: 1,
      },
    },
    {
      operation: "graph.backbone",
      backbone: {
        project_id: "project", head: "a".repeat(64), pending_candidate_count: 0,
        nodes: [{ kind: "repository", identity: "repo", display_name: "Repo" }],
        relations: [{
          source: "repo", target: "api", relation: "owns", evidence_count: 2,
        }],
      },
    },
    {
      operation: "graph.repository",
      graph: {
        project_id: "project", repository_id: "repo", revision: "revision",
        weavatrix_version: "2.17.0", total_nodes: 2, total_relations: 1,
        architecture_hypotheses: [{
          name: "onion", dimension: "dependency_direction", status: "CANDIDATE",
          evidence: ["application_to_core: src/application → src/domain (imports)"],
          contradictions: [], unknowns: ["implementation not resolved"],
        }],
        truncated: false,
        nodes: [
          { id: "repo", kind: "repository", label: "Repo" },
          { id: "src", kind: "module", label: "src" },
        ],
        relations: [{ source: "repo", target: "src", relation: "contains" }],
      },
    },
    {
      operation: "context.compiled",
      compilation: {
        project_id: "project", task_id: "task", cortex_version: "0.1.0",
        cortex_revision: "a".repeat(40),
        packet: {
          content: "<evidence>goal</evidence>", included_ids: ["goal"], omitted_ids: [],
          raw_estimated_tokens: 10, selected_estimated_tokens: 10,
          omitted_estimated_tokens: 0, requires_upstream: true,
          deduplicated_lines: 0, deduplicated_estimated_tokens: 0,
          packet_id: "pk_123", snapshot_id: "git:abc",
        },
      },
    },
    {
      operation: "policy.evaluated",
      decision: {
        effect: "ask", source: "project", reason: "project requires approval",
        rule_id: "ask-deploy", policy_revision: 3,
        fingerprint_confidence: "strong", coverage: "enforced",
      },
    },
    {
      operation: "policy.found",
      policy: { project_id: "project", revision: 0, enforcement: "best_available", rules: [] },
    },
    {
      operation: "policy.applied",
      policy: {
        project_id: "project", revision: 1, enforcement: "strict",
        rules: [{
          rule_id: "deny-mcp", project_id: "project", selector: { kind: "mcp" },
          effect: "deny", conditions: { endpoint_ids: [], providers: [] },
          revision: 1, created_by: "phone",
        }],
      },
    },
    {
      operation: "policy.coverage",
      coverage: {
        project_id: "project", policy_revision: 1, enforcement: "strict",
        required_capabilities: ["mcp"], endpoints: [], strict_ready: false,
      },
    },
    {
      operation: "policy.acknowledged",
      acknowledgement: {
        project_id: "project", policy_revision: 1, endpoint_id: "mac",
        provider: "claude", capabilities: [{ kind: "mcp", status: "enforced" }],
        observed_at: 1,
      },
    },
  ];
  for (const result of results) {
    assert.equal(parseEngineResponse(response(result), "request-1").operation, result.operation);
  }
});

test("response parser exposes bounded engine errors", () => {
  assert.throws(
    () => parseEngineResponse({
      protocol_version: 1,
      request_id: "request-1",
      status: "error",
      error: { code: "PROJECT_UNRESOLVED", message: "identity required" },
    }, "request-1"),
    (error) => error instanceof EngineRemoteError
      && error.code === "PROJECT_UNRESOLVED"
      && error.message === "identity required",
  );
});

test("invocation history results are parsed and bounded", () => {
  const event = {
    event_id: "request", invocation_id: "call", project_id: "project", task_id: "task",
    execution_id: "execution", provider: "claude", native_call_id: "native", tool_name: "Edit",
    phase: "requested", source: "transcript", occurred_at: 2,
    repository_id: "frontend", worktree: "/repo", resource: "src/index.ts",
    revision: null, content_hash: null, capability_artifact_hash: null, policy_revision: null,
  };
  const page = { events: [{ sequence: 1, event }], next_sequence: 1, has_more: false,
    previous_sequence: 1, has_older: false };
  assert.equal(parseEngineResponse(response({ operation: "invocation.observed", sequence: 1 }), "request-1").operation,
    "invocation.observed");
  assert.equal(parseEngineResponse(response({ operation: "invocation.history", page }), "request-1").operation,
    "invocation.history");
  assert.throws(() => parseEngineResponse(response({
    operation: "invocation.history", page: { ...page, events: [{ sequence: 1, event: { ...event, phase: "executed" } }] },
  }), "request-1"), EngineProtocolError);
});

test("response parser rejects malformed and incompatible wire values", () => {
  const invalid = [
    null,
    { ...response({ operation: "engine.pong", engine_version: "0.1.0" }), protocol_version: 2 },
    { ...response({ operation: "engine.pong", engine_version: "0.1.0" }), request_id: "other" },
    { ...response({ operation: "engine.pong", engine_version: "0.1.0" }), status: "later" },
    { protocol_version: 1, request_id: "request-1", status: "error", error: {} },
    response({ operation: "engine.unknown" }),
    response({ operation: "engine.pong", engine_version: "" }),
    response({
      operation: "engine.version", engine_version: "0.1.0", protocol_version: 2,
      cortex_version: "0.1.0", cortex_revision: "a".repeat(40), weavatrix_version: "2.17.0",
    }),
    response({ operation: "project.resolved", resolution: [] }),
    response({ operation: "project.resolved", resolution: { project_id: "p" } }),
    response({
      operation: "graph.backbone",
      backbone: { project_id: "project", nodes: [{}], relations: [], pending_candidate_count: 0 },
    }),
    response({
      operation: "graph.repository",
      graph: {
        project_id: "project", repository_id: "repo", revision: "revision",
        weavatrix_version: "2.17.0", total_nodes: 1, total_relations: 0,
        truncated: false, nodes: [{}], relations: [],
      },
    }),
    response({
      operation: "graph.repository",
      graph: {
        project_id: "project", repository_id: "repo", revision: "revision",
        weavatrix_version: "2.17.4", total_nodes: 0, total_relations: 0,
        truncated: false, nodes: [], relations: [],
        architecture_hypotheses: [{ name: "onion", dimension: "dependency_direction",
          status: "CERTAIN", evidence: [], contradictions: [], unknowns: [] }],
      },
    }),
    response({
      operation: "context.compiled",
      compilation: {
        project_id: "project", task_id: "task", cortex_version: "0.1.0",
        cortex_revision: "a".repeat(40),
        packet: { content: "", included_ids: [], omitted_ids: [], raw_estimated_tokens: 0,
          selected_estimated_tokens: 0, omitted_estimated_tokens: 0,
          requires_upstream: false, deduplicated_lines: 0, deduplicated_estimated_tokens: 0 },
      },
    }),
    response({
      operation: "policy.evaluated",
      decision: { effect: "maybe", source: "project", reason: "x" },
    }),
    response({
      operation: "policy.evaluated",
      decision: { effect: "deny", source: "future", reason: "x" },
    }),
    response({
      operation: "policy.evaluated",
      decision: { effect: "deny", source: "project", reason: "" },
    }),
    response({
      operation: "policy.evaluated",
      decision: { effect: "deny", source: "project", reason: "x", policy_revision: -1 },
    }),
    response({
      operation: "policy.evaluated",
      decision: { effect: "deny", source: "project", reason: "x", coverage: "claimed" },
    }),
    response({
      operation: "policy.applied",
      policy: { project_id: "project", revision: 1, enforcement: "strict", rules: [{}] },
    }),
    response({
      operation: "policy.applied",
      policy: { project_id: "project", revision: 0, enforcement: "best_available", rules: [] },
    }),
    response({
      operation: "policy.coverage",
      coverage: {
        project_id: "project", policy_revision: 1, enforcement: "strict",
        required_capabilities: ["future"], endpoints: [], strict_ready: true,
      },
    }),
    response({
      operation: "policy.acknowledged",
      acknowledgement: {
        project_id: "project", policy_revision: 1, endpoint_id: "mac",
        provider: "claude", capabilities: [{ kind: "mcp", status: "claimed" }],
        observed_at: 1,
      },
    }),
  ];
  for (const value of invalid) {
    assert.throws(() => parseEngineResponse(value, "request-1"), EngineProtocolError);
  }
});

test("encoder and decoder reject unbounded or non-JSON frames", () => {
  assert.throws(() => encodeEngineFrame(undefined), /serializable/i);
  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.throws(() => encodeEngineFrame(circular), /serializable/i);
  assert.throws(() => encodeEngineFrame("x".repeat(MAX_ENGINE_FRAME_BYTES)), /512 KiB/i);

  const empty = Buffer.alloc(4);
  assert.throws(() => new EngineFrameDecoder().push(empty), /length/i);
  const invalidJson = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from("{")]);
  assert.throws(() => new EngineFrameDecoder().push(invalidJson), /valid JSON/i);
  const arrayFrame = encodeEngineFrame([]);
  assert.throws(() => new EngineFrameDecoder().push(arrayFrame), /must be an object/i);
  assert.deepEqual(new EngineFrameDecoder().push(Buffer.alloc(0)), []);
});

test("decoder returns every complete frame and retains an incomplete tail", () => {
  const first = encodeEngineFrame({ id: 1 });
  const second = encodeEngineFrame({ id: 2 });
  const third = encodeEngineFrame({ id: 3 });
  const decoder = new EngineFrameDecoder();
  const split = third.length - 2;
  assert.deepEqual(
    decoder.push(Buffer.concat([first, second, third.subarray(0, split)])),
    [{ id: 1 }, { id: 2 }],
  );
  assert.deepEqual(decoder.push(third.subarray(split)), [{ id: 3 }]);
});
