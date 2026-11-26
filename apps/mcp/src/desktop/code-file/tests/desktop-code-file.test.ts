import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { ProjectCodeFileResult } from "../../../../../../packages/protocol/schema";
import {
  EngineFrameDecoder, EngineRemoteError, encodeEngineFrame, type EngineRequest,
} from "../../../../../bridge/src/engine/protocol/engine-protocol";
import { startDesktopEngineBridge } from "../../engine-bridge";

function exchange(socketPath: string, input: unknown): Promise<Record<string, any> | undefined> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    socket.setTimeout(5_000, () => { socket.destroy(); reject(Error("Code file read timed out")); });
    socket.on("data", data => chunks.push(data));
    socket.once("error", reject);
    socket.once("close", () => {
      const bytes = Buffer.concat(chunks);
      resolve(bytes.length > 4 ? JSON.parse(bytes.subarray(4).toString()) : undefined);
    });
    socket.once("connect", () => socket.write(encodeEngineFrame({
      protocol_version: 1, request_id: "code-file", operation: "desktop.code_file", input,
    })));
  });
}

/** A computer with one local checkout bound to one Mesh, and an Engine that analyses it on request. */
async function computer(t: test.TestContext) {
  const config = mkdtempSync("/tmp/granttap-desktop-code-");
  const checkout = realpathSync(mkdtempSync("/tmp/granttap-desktop-repo-"));
  execFileSync("git", ["init", "-q", checkout]);
  const prior = { config: process.env.GRANTTAP_CONFIG_DIR, engine: process.env.GRANTTAP_ENGINE_ENABLED };
  process.env.GRANTTAP_CONFIG_DIR = config;
  process.env.GRANTTAP_ENGINE_ENABLED = "1";
  writeFileSync(join(config, "computer.json"), JSON.stringify({ computerId: "mac", names: ["mac"], createdAt: 1 }));
  const repositoryId = `local:${checkout}`;
  const storePath = join(config, "mesh.json");
  writeFileSync(storePath, JSON.stringify({ version: 1, tasks: [], executions: [],
    projects: [{ projectId: "mesh-a", name: "App", canonicalRepositoryId: repositoryId, createdAt: 1 }],
    bindings: [{ projectId: "mesh-a", bindingId: "b1", endpointId: "mac", repositoryId, displayName: "App",
      available: true, localPathHint: checkout }] }));
  const state = { cached: false, analyses: 0 };
  const engineSocket = createServer(socket => {
    const decoder = new EngineFrameDecoder();
    socket.on("data", chunk => {
      for (const request of decoder.push(chunk) as Array<EngineRequest & { input: any }>) {
        if (request.operation === "graph.analyze_repository") { state.analyses++; state.cached = true; }
        const result = request.operation === "project.upsert_binding"
          ? { operation: "project.binding_upserted", binding: request.input.binding }
          : { operation: "graph.repository", graph: { project_id: "mesh-a", repository_id: repositoryId,
            revision: "content-1", weavatrix_version: "2.17.17", analysis_status: "COMPLETE", nodes: [], relations: [],
            total_nodes: 0, total_relations: 0, truncated: false } };
        socket.write(encodeEngineFrame({ protocol_version: 1, request_id: request.request_id, status: "ok", result }));
      }
    });
  });
  await new Promise<void>(resolve => engineSocket.listen(join(config, "engine.sock"), resolve));
  const reads: unknown[] = [];
  const bridge = await startDesktopEngineBridge({ storePath, client: { close() {}, async request(operation) {
    reads.push(operation);
    if (operation.operation !== "graph.code_file") throw Error("only code file reads reach this channel");
    if (!state.cached) throw new EngineRemoteError("CODE_MAP_NOT_CACHED", "not analysed since the Engine started");
    return { operation: "graph.code_file", file: { project_id: "mesh-a", repository_id: repositoryId,
      revision: "content-1", analysis_id: null, path: operation.input.path, language: "Swift", line_count: 30,
      symbols: [{ id: "a", label: "body", kind: "function", start_line: 3, line_count: 4 }], total_symbols: 1,
      truncated: false } };
  } } });
  t.after(async () => {
    await bridge.close();
    await new Promise<void>(resolve => engineSocket.close(() => resolve()));
    if (prior.config === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = prior.config;
    if (prior.engine === undefined) delete process.env.GRANTTAP_ENGINE_ENABLED;
    else process.env.GRANTTAP_ENGINE_ENABLED = prior.engine;
    rmSync(config, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  });
  return { bridge, repositoryId, state, reads };
}

test("the Mac app reads a file's sections, starting the analysis instead of waiting for it", async t => {
  const { bridge, repositoryId, state } = await computer(t);
  const input = { project_id: "mesh-a", repository_id: repositoryId, path: "Sources/App.swift" };
  const first = await exchange(bridge.socketPath, input);
  assert.equal(first?.status, "ok");
  assert.equal(first?.result.operation, "desktop.code_file");
  const analyzing = ProjectCodeFileResult.parse(first?.result.result);
  assert.deepEqual([analyzing.status, analyzing.requestId, analyzing.symbols.length], ["analyzing", "local", 0]);
  let answer = analyzing;
  for (const deadline = Date.now() + 10_000; answer.status === "analyzing" && Date.now() < deadline;) {
    await new Promise(resolve => setTimeout(resolve, 50));
    answer = ProjectCodeFileResult.parse((await exchange(bridge.socketPath, { ...input, request_id: "mac-2" }))
      ?.result.result);
  }
  assert.deepEqual([answer.status, answer.requestId, answer.language, answer.totalSymbols],
    ["ok", "mac-2", "Swift", 1]);
  assert.deepEqual(answer.symbols, [{ id: "a", label: "body", kind: "function", startLine: 3, lineCount: 4 }]);
  assert.equal(state.analyses, 1, "every poll during the analysis joined the one analysis");
});

test("the Mac app is told plainly about a repository this computer does not hold, and bad input is refused", async t => {
  const { bridge, reads } = await computer(t);
  const elsewhere = await exchange(bridge.socketPath, { project_id: "mesh-a", repository_id: "github.com/me/other",
    path: "src/a.ts" });
  assert.equal(elsewhere?.result.result.status, "not_bound");
  assert.equal(reads.length, 0);
  for (const input of [{ project_id: "mesh-a", repository_id: "r", path: "../secret" },
    { project_id: "mesh-a", repository_id: "r" }, { project_id: "", repository_id: "r", path: "a.ts" },
    { project_id: "mesh-a", repository_id: "r", path: "a.ts", request_id: "" }]) {
    assert.equal(await exchange(bridge.socketPath, input), undefined, JSON.stringify(input));
  }
});
