import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EngineSupervisor } from "../../engine-supervisor";
import { EngineClient } from "../../engine-client";

const binary = process.env.GRANTTAP_ENGINE_TEST_BINARY;
test("supervised native Engine analyzes a long Rust expression without losing Graph or policy IPC", {
  skip: !binary && "requires the published native Engine", timeout: 30_000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-parser-stack-"));
  const checkout = join(root, "fixture");
  mkdirSync(join(checkout, "src"), { recursive: true });
  execFileSync("git", ["init", "--quiet", checkout]);
  writeFileSync(join(checkout, "src/lib.rs"),
    "pub fn leaf()->u64 { 1 }\npub fn calculate()->u64 { " + Array(4096).fill("leaf()").join("+") + " }\n");
  const socketPath = join(root, "engine.sock");
  const originalMinimum = process.env.RUST_MIN_STACK;
  const env: NodeJS.ProcessEnv = { ...process.env, GRANTTAP_ENGINE_ENABLED: "1", GRANTTAP_ENGINE_BINARY: binary!,
    GRANTTAP_ENGINE_SHA256: createHash("sha256").update(readFileSync(binary!)).digest("hex") };
  delete env.RUST_MIN_STACK;
  const supervisor = new EngineSupervisor({ env, socketPath });
  const client = new EngineClient({ socketPath });
  t.after(async () => {
    client.close();
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal((await supervisor.ensureAvailable()).state, "healthy");
  await client.request({ operation: "project.upsert_binding", input: {
    project: { project_id: "fixture", name: "Stack fixture", created_at: 1 },
    binding: { binding_id: "fixture", project_id: "fixture", endpoint_id: "isolated",
      repository_id: `local:${checkout}`, local_root: checkout, role: "primary", last_seen_at: 1 },
  } });
  const response = await client.request({ operation: "graph.analyze_repository", input: {
    project_id: "fixture", repository_id: `local:${checkout}`,
  } }, { timeoutMs: 20_000 });
  assert.equal(response.operation, "graph.repository");
  if (response.operation !== "graph.repository") throw Error("Missing Graph");
  assert.equal(response.graph.analysis_status, "COMPLETE");
  assert.ok(response.graph.code_map?.files.some(file => file.path === "src/lib.rs"));
  assert.equal((await client.request({ operation: "engine.ping" })).operation, "engine.pong");
  assert.equal((await supervisor.ensureAvailable()).state, "healthy");
  assert.equal(process.env.RUST_MIN_STACK, originalMinimum, "The parent environment must remain unchanged");
  assert.equal(env.RUST_MIN_STACK, undefined, "The launch input is not a mutable global setting");
});
