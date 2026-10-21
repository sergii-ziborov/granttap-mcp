import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { EngineClient } from "../../../../engine/runtime/engine-client";

const binary = process.env.GRANTTAP_ENGINE_TEST_BINARY;
test("native Engine excludes local Git build artifacts while retaining untracked source", {
  skip: !binary && "requires a built native Engine", timeout: 30_000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-native-selection-"));
  const checkout = join(root, "repo");
  mkdirSync(checkout);
  execFileSync("git", ["init", "--quiet", checkout]);
  mkdirSync(join(checkout, "src"));
  mkdirSync(join(checkout, ".artifacts"));
  writeFileSync(join(checkout, ".git/info/exclude"), "/.artifacts/\n.hidden/worktrees/\n");
  const nested = join(checkout, ".hidden/worktrees/archived");
  mkdirSync(join(nested, "src"), { recursive: true });
  execFileSync("git", ["init", "--quiet", nested]);
  writeFileSync(join(nested, "src/foreign.ts"), "export function foreignCheckout() { return 3; }\n");
  writeFileSync(join(checkout, "src/main.ts"), "export function realSource() { return 1; }\n");
  writeFileSync(join(checkout, ".artifacts/generated.ts"), "export function buildArtifact() { return 2; }\n");
  const socketPath = join(root, "engine.sock");
  const child = spawn(binary!, [], { env: { ...process.env, GRANTTAP_ENGINE_SOCKET: socketPath }, stdio: "ignore" });
  const client = new EngineClient({ socketPath });
  t.after(async () => {
    client.close();
    if (child.exitCode == null) {
      const stopped = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await stopped;
    }
    rmSync(root, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 100 && !existsSync(socketPath); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await client.request({ operation: "project.upsert_binding", input: {
    project: { project_id: "fixture", name: "Fixture", created_at: 1 },
    binding: { binding_id: "checkout", project_id: "fixture", endpoint_id: "mac",
      repository_id: `local:${checkout}`, local_root: checkout, role: "primary", last_seen_at: 1 },
  } });
  const result = await client.request({ operation: "graph.analyze_repository", input: {
    project_id: "fixture", repository_id: `local:${checkout}`,
  } }, { timeoutMs: 20_000 });
  assert.equal(result.operation, "graph.repository");
  if (result.operation !== "graph.repository") throw new Error("missing graph");
  const files = result.graph.code_map?.files.map(file => file.path) ?? [];
  assert.ok(files.includes("src/main.ts"), "uncommitted source remains visible");
  assert.ok(!files.includes(".artifacts/generated.ts"), "Git-local excluded build output must not enter analysis");
  assert.ok(!files.some(path => path.startsWith(".hidden/worktrees/")), "Ignored nested checkouts are outside the report");
});
