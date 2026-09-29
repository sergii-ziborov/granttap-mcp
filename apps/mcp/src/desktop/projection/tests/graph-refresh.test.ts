import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import test from "node:test";
import { DesktopTaskActivityRunner } from "../../task-activity-runner";
import { EngineFrameDecoder, encodeEngineFrame, type EngineRequest } from "../../../../../bridge/src/engine/protocol/engine-protocol";
import { MeshSnapshot } from "../../../../../../packages/protocol/schema";

test("selected Mac refresh admits its checkout and returns completed Engine analysis through the worker", async () => {
  const root = mkdtempSync("/tmp/granttap-graph-refresh-");
  const checkout = `${root}/checkout`;
  mkdirSync(checkout);
  execFileSync("git", ["init", "--quiet", checkout]);
  execFileSync("git", ["-C", checkout, "-c", "user.name=sergii-ziborov",
    "-c", "user.email=sergii.ziborov@gmail.com", "commit", "--quiet", "--allow-empty", "-m", "Fixture"]);
  execFileSync("git", ["-C", checkout, "remote", "add", "origin", "https://github.com/example/refresh.git"]);
  const names = ["GRANTTAP_CONFIG_DIR", "GRANTTAP_COMPUTER_ID", "GRANTTAP_ENGINE_ENABLED",
    "GRANTTAP_CODEX_DIR", "GRANTTAP_CLAUDE_DIR"];
  const previous = names.map((key) => process.env[key]);
  for (const key of names) process.env[key] = root;
  process.env.GRANTTAP_COMPUTER_ID = "test-mac";
  process.env.GRANTTAP_ENGINE_ENABLED = "1";
  writeFileSync(`${root}/runtime.json`, JSON.stringify({ contextCompilerEnabled: false }));
  writeFileSync(`${root}/project-mesh.json`, JSON.stringify({ version: 1,
    projects: [{ projectId: "refresh", name: "Refresh", canonicalRepositoryId: "github.com/example/refresh", createdAt: 1 }],
    tasks: [], executions: [], bindings: [{ bindingId: "checkout", projectId: "refresh",
      endpointId: "test-mac", repositoryId: "github.com/example/refresh", displayName: "Refresh",
      available: true, localPathHint: checkout },
      { bindingId: "old-local-alias", projectId: "refresh", endpointId: "test-mac",
        repositoryId: `local:${checkout}`, displayName: "Refresh", available: true, localPathHint: checkout }],
  }));
  const calls: string[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const decoder = new EngineFrameDecoder();
    socket.on("data", (chunk) => {
      for (const request of decoder.push(chunk) as EngineRequest[]) {
        calls.push(request.operation);
        const result = engineResult(request);
        socket.write(encodeEngineFrame({ protocol_version: 1, request_id: request.request_id,
          ...(result ? { status: "ok", result } : { status: "error",
            error: { code: "UNAVAILABLE", message: "No fixture report" } }) }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(`${root}/engine.sock`, resolve);
  });
  const worker = new DesktopTaskActivityRunner();
  try {
    const result = MeshSnapshot.parse(await worker.enrichedSnapshot("refresh", true));
    assert.equal(result.repositoryGraphs?.[0]?.analysisStatus, "COMPLETE");
    assert.equal(result.repositoryGraphs?.[0]?.totalNodes, 4);
    const alias = result.repositoryGraphs?.find((report) => report.repositoryId.startsWith("local:"));
    assert.equal(alias?.analysisErrorCode, "REPOSITORY_IDENTITY_MISMATCH");
    assert.equal(alias?.totalNodes, 0);
    assert.ok(calls.indexOf("project.upsert_binding") >= 0);
    assert.ok(calls.indexOf("project.upsert_binding") < calls.indexOf("graph.analyze_repository"));
    assert.equal(await worker.enrichedSnapshot("foreign", true), undefined);
    assert.equal(calls.filter((call) => call === "graph.analyze_repository").length, 1);
  } finally {
    worker.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    names.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    });
    rmSync(root, { recursive: true, force: true });
  }
});

function engineResult(request: EngineRequest): unknown {
  if (request.operation === "project.upsert_binding") {
    return { operation: "project.binding_upserted", binding: request.input.binding };
  }
  if (request.operation === "graph.analyze_repository") {
    return { operation: "graph.repository", graph: {
      project_id: request.input.project_id, repository_id: request.input.repository_id,
      revision: "fixture-sha", weavatrix_version: "2.17.4", analysis_status: "COMPLETE",
      nodes: [], relations: [], total_nodes: 4, total_relations: 0, truncated: false,
    } };
  }
  return undefined;
}
