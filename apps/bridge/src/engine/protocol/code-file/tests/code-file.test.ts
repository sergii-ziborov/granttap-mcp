import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import test from "node:test";
import { EngineClient } from "../../../runtime/engine-client";
import {
  EngineFrameDecoder, EngineProtocolError, EngineRemoteError, encodeEngineFrame, parseEngineResponse,
  type EngineRequest,
} from "../../engine-protocol";

const file = {
  project_id: "mesh-a", repository_id: "github.com/me/app", revision: "content-1", analysis_id: "analysis-1",
  path: "src/api.ts", language: "TypeScript", line_count: 120, total_symbols: 3, truncated: false,
  symbols: [
    { id: "src/api.ts#register", label: "register", kind: "function", start_line: 4, line_count: 10,
      metrics: { measured: true, source_lines: 10, cyclomatic: 2, max_loop_depth: 1, callers: 3 } },
    { id: "src/api.ts#resolve", label: "resolve", kind: "function", start_line: 20, line_count: 6 },
  ],
};
const response = (result: unknown) => ({ protocol_version: 1, request_id: "r", status: "ok", result });

test("an Engine code file is read under file, code_file or beside its operation", () => {
  for (const result of [{ operation: "graph.code_file", file }, { operation: "graph.code_file", code_file: file },
    { operation: "graph.code_file", ...file }]) {
    const parsed = parseEngineResponse(response(result), "r");
    assert.equal(parsed.operation, "graph.code_file");
    if (parsed.operation !== "graph.code_file") return;
    assert.deepEqual(parsed.file, file);
  }
  const unknown = parseEngineResponse(response({ operation: "graph.code_file",
    file: { ...file, analysis_id: null, language: null, line_count: null } }), "r");
  assert.equal(unknown.operation === "graph.code_file" && unknown.file.analysis_id, null);
  const empty = parseEngineResponse(response({ operation: "graph.code_file", ...file, line_count: 0 }), "r");
  assert.equal(empty.operation === "graph.code_file" && empty.file.line_count, null, "an empty file's size is unknown");
});

test("a malformed Engine code file fails the response instead of reaching the phone", () => {
  const symbol = file.symbols[0]!;
  for (const broken of [
    { ...file, symbols: undefined }, { ...file, total_symbols: 1 }, { ...file, truncated: "no" },
    { ...file, path: "" }, { ...file, path: "p".repeat(513) }, { ...file, revision: "" }, { ...file, line_count: -1 },
    { ...file, language: "l".repeat(65) }, { ...file, symbols: [{ ...symbol, start_line: 0 }] },
    { ...file, symbols: [{ ...symbol, label: "" }] }, { ...file, symbols: [{ ...symbol, id: "i".repeat(513) }] },
    { ...file, symbols: [{ ...symbol, metrics: { ...symbol.metrics, cyclomatic: 0 } }] },
  ]) {
    assert.throws(() => parseEngineResponse(response({ operation: "graph.code_file", file: broken }), "r"),
      EngineProtocolError, JSON.stringify(broken).slice(0, 80));
  }
});

test("Engine refusals of a code file keep their code", () => {
  for (const code of ["CODE_MAP_NOT_CACHED", "CODE_FILE_NOT_FOUND", "REPOSITORY_NOT_BOUND", "INVALID_OPERATION"]) {
    assert.throws(() => parseEngineResponse({ protocol_version: 1, request_id: "r", status: "error",
      error: { code, message: "refused" } }, "r"), (error: unknown) => error instanceof EngineRemoteError
      && error.code === code);
  }
});

test("the Engine client sends graph.code_file and accepts its own answer", async t => {
  const path = `/tmp/granttap-code-file-${process.pid}.sock`;
  await rm(path, { force: true });
  const requests: EngineRequest[] = [];
  const server = createServer(socket => {
    const decoder = new EngineFrameDecoder();
    socket.on("data", chunk => {
      for (const request of decoder.push(chunk) as EngineRequest[]) {
        requests.push(request);
        const input = (request as { input?: { path?: string } }).input;
        socket.write(encodeEngineFrame(input?.path === "missing.ts"
          ? { protocol_version: 1, request_id: request.request_id, status: "error",
            error: { code: "CODE_FILE_NOT_FOUND", message: "no such file in the code map" } }
          : { protocol_version: 1, request_id: request.request_id, status: "ok",
            result: { operation: "graph.code_file", file } }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const client = new EngineClient({ socketPath: path });
  t.after(async () => { client.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(path, { force: true }); });
  const input = { project_id: "mesh-a", repository_id: "github.com/me/app", path: "src/api.ts" };
  const result = await client.request({ operation: "graph.code_file", input });
  assert.equal(result.operation === "graph.code_file" && result.file.symbols.length, 2);
  assert.deepEqual((requests[0] as { input?: unknown }).input, input);
  await assert.rejects(client.request({ operation: "graph.code_file", input: { ...input, path: "missing.ts" } }),
    (error: unknown) => error instanceof EngineRemoteError && error.code === "CODE_FILE_NOT_FOUND");
});
