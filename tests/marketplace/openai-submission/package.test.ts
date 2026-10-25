import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { assemblePlugin, publicRuntimePath, submissionManifest } from "../../../scripts/openai-submission/index.mjs";

const root = resolve(import.meta.dirname, "../../..");

test("assembled directory launches a bundled runtime without loopback or private evidence", () => {
  const scratch = mkdtempSync(join(tmpdir(), "granttap-openai-package-"));
  const runtimeRoot = join(scratch, "runtime");
  for (const directory of ["bin", "node_modules/tsx", "node_modules/.bin", "apps/test", "docs/superpowers"]) {
    mkdirSync(join(runtimeRoot, directory), { recursive: true });
  }
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  writeFileSync(join(runtimeRoot, "package.json"), JSON.stringify({ name: "granttap-mcp", version }));
  writeFileSync(join(runtimeRoot, "bin/granttap-mcp.mjs"), "export {};\n");
  writeFileSync(join(runtimeRoot, "node_modules/tsx/package.json"), "{}\n");
  const excluded = ["AGENTS.md", ".env", "apps/test/private.ts", "docs/superpowers/plan.md",
    "node_modules/.bin/tsx", "node_modules/tsx/index.d.ts", "node_modules/tsx/index.js.map"];
  for (const path of excluded) {
    writeFileSync(join(runtimeRoot, path), "not public\n");
  }
  const output = join(scratch, "plugin");
  const report = assemblePlugin({ output, runtimeRoot, root });
  assert.equal(report.runtimeVersion, version);
  const manifest = JSON.parse(readFileSync(join(output, "plugin.json"), "utf8"));
  assert.equal(manifest.extensions["com.openai"].requires_local_executor, true);
  assert.equal(manifest.mcpServers, undefined);
  const mcp = JSON.parse(readFileSync(join(output, "mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers.granttap, {
    type: "stdio", command: "node",
    args: ["${PLUGIN_ROOT}/runtime/bin/granttap-mcp.mjs"], cwd: "${PLUGIN_ROOT}",
  });
  assert.equal(existsSync(join(output, "skills/granttap-connect/SKILL.md")), true);
  assert.equal(existsSync(join(output, "assets/logo.png")), true);
  assert.equal(existsSync(join(output, "runtime/node_modules/tsx/package.json")), true);
  for (const path of excluded) {
    assert.equal(existsSync(join(output, "runtime", path)), false);
  }
  assert.throws(() => assemblePlugin({ output, runtimeRoot, root }), /must be empty/);
});

test("incomplete runtimes and overlong public metadata fail before packaging", () => {
  const scratch = mkdtempSync(join(tmpdir(), "granttap-openai-invalid-"));
  writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "granttap-mcp", version: "0.0.0" }));
  assert.throws(() => assemblePlugin({ output: join(scratch, "plugin"), runtimeRoot: scratch, root }), /must match/);
  assert.throws(() => submissionManifest({ interface: { shortDescription: "x".repeat(31), defaultPrompt: [] } }), /copy limits/);
  for (const path of ["AGENTS.md", ".npmrc", "private.pem", "docs/audits/x.md", "apps/a/tests/x.ts"]) {
    assert.equal(publicRuntimePath(path), false);
  }
  assert.equal(publicRuntimePath("apps/mcp/src/server.ts"), true);
});
