import assert from "node:assert/strict";
import test from "node:test";
import {
  EngineFrameDecoder,
  EngineProtocolError,
  EngineRemoteError,
  MAX_ENGINE_FRAME_BYTES,
  encodeEngineFrame,
  parseEngineResponse,
} from "../apps/bridge/src/engine/engine-protocol";

const response = (result: unknown) => ({
  protocol_version: 1,
  request_id: "request-1",
  status: "ok",
  result,
});

test("response parser accepts every Rust v1 result", () => {
  const results = [
    { operation: "engine.pong", engine_version: "0.1.0" },
    { operation: "engine.version", engine_version: "0.1.0", protocol_version: 1 },
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
      operation: "policy.evaluated",
      decision: {
        effect: "ask", source: "project", reason: "project requires approval",
        rule_id: "ask-deploy", policy_revision: 3,
        fingerprint_confidence: "strong", coverage: "enforced",
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

test("response parser rejects malformed and incompatible wire values", () => {
  const invalid = [
    null,
    { ...response({ operation: "engine.pong", engine_version: "0.1.0" }), protocol_version: 2 },
    { ...response({ operation: "engine.pong", engine_version: "0.1.0" }), request_id: "other" },
    { ...response({ operation: "engine.pong", engine_version: "0.1.0" }), status: "later" },
    { protocol_version: 1, request_id: "request-1", status: "error", error: {} },
    response({ operation: "engine.unknown" }),
    response({ operation: "engine.pong", engine_version: "" }),
    response({ operation: "engine.version", engine_version: "0.1.0", protocol_version: 2 }),
    response({ operation: "project.resolved", resolution: [] }),
    response({ operation: "project.resolved", resolution: { project_id: "p" } }),
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
  assert.throws(() => encodeEngineFrame("x".repeat(MAX_ENGINE_FRAME_BYTES)), /64 KiB/i);

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
