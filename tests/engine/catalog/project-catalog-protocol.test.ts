import assert from "node:assert/strict";
import test from "node:test";
import { parseEngineResponse } from "../../../apps/bridge/src/engine/protocol/engine-protocol";

function reply(projects: unknown[], next: unknown): unknown {
  return {
    protocol_version: 1, request_id: "catalog", status: "ok",
    result: { operation: "project.listed", page: {
      projects, next_after_project_id: next,
    } },
  };
}

const project = (id: string) => ({ project_id: id, name: id, created_at: 1 });

test("MCP bridge accepts the bounded Engine Project catalog", () => {
  const result = parseEngineResponse(reply([project("alpha")], null), "catalog");
  assert.equal(result.operation, "project.listed");
  assert.throws(() => parseEngineResponse(reply([project("beta"), project("alpha")], null), "catalog"));
  assert.throws(() => parseEngineResponse(reply([project("alpha")], "alpha"), "catalog"));
});
