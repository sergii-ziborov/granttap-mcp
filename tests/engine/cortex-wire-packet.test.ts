import assert from "node:assert/strict";
import test from "node:test";
import {
  EngineProtocolError,
  parseEngineResponse,
} from "../../apps/bridge/src/engine/protocol/engine-protocol";

test("Cortex packet from the linked Rust library retains IDs and token counts", () => {
  const compilation = {
    project_id: "project", task_id: "task", cortex_version: "0.1.0",
    cortex_revision: "a".repeat(40),
    packet: {
      content: "evidence", includedIds: ["goal"], omittedIds: ["older"],
      rawEstimatedTokens: 20, selectedEstimatedTokens: 10,
      omittedEstimatedTokens: 10, requiresUpstream: true,
      deduplicatedLines: 1, deduplicatedEstimatedTokens: 2,
      packetId: "packet", snapshotId: "git:abc",
    },
  };
  const response = (value: unknown) => ({
    protocol_version: 1, request_id: "request-1", status: "ok", result: value,
  });
  const parsed = parseEngineResponse(response({ operation: "context.compiled", compilation }), "request-1");
  assert.equal(parsed.operation, "context.compiled");
  if (parsed.operation !== "context.compiled") return;
  assert.deepEqual(parsed.compilation.packet.included_ids, ["goal"]);
  assert.equal(parsed.compilation.packet.packet_id, "packet");
  assert.equal(parsed.compilation.packet.snapshot_id, "git:abc");
  assert.equal(parsed.compilation.packet.selected_estimated_tokens, 10);
  assert.throws(() => parseEngineResponse(response({
    operation: "context.compiled",
    compilation: { ...compilation, packet: { ...compilation.packet, included_ids: ["forged"] } },
  }), "request-1"), EngineProtocolError);
});
