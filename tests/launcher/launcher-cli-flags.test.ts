import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "../..");
const launcher = join(root, "bin/granttap-mcp.mjs");

function isolated(t: test.TestContext): { directory: string; env: NodeJS.ProcessEnv } {
  const directory = mkdtempSync(join(tmpdir(), "granttap-cli-flags-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const path of ["home", "config", "cursor", "claude", "codex", "agents"]) mkdirSync(join(directory, path));
  return { directory, env: { ...process.env,
    HOME: join(directory, "home"), GRANTTAP_CONFIG_DIR: join(directory, "config"),
    NODVOX_CONFIG_DIR: join(directory, "legacy-config"), GRANTTAP_CURSOR_DIR: join(directory, "cursor"),
    GRANTTAP_CURSOR_MCP_CONFIG: join(directory, "cursor", "mcp.json"), GRANTTAP_CLAUDE_DIR: join(directory, "claude"),
    GRANTTAP_CODEX_DIR: join(directory, "codex"), GRANTTAP_CODEX_BIN: join(directory, "missing-codex"),
    GRANTTAP_LAUNCH_AGENTS_DIR: join(directory, "agents"), GRANTTAP_SKIP_LAUNCHCTL: "1", GRANTTAP_SKIP_PAIRING: "1" } };
}

const tree = (directory: string) => readdirSync(directory, { recursive: true }).map(String).sort();

test("version flags print the package version on stdout and exit cleanly", t => {
  const { env } = isolated(t);
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  for (const flag of ["--version", "-v", "version"]) {
    const result = spawnSync(process.execPath, [launcher, flag], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 0, `${flag}: ${result.stderr}`);
    assert.equal(result.stdout, `${version}\n`);
    assert.equal(result.stderr, "");
  }
  const help = spawnSync(process.execPath, [launcher, "--help"], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
  assert.match(help.stdout, /granttap --version/);
});

test("setup help explains setup and changes nothing on the computer", t => {
  const { directory, env } = isolated(t);
  const before = tree(directory);
  for (const flag of ["--help", "-h"]) {
    const result = spawnSync(process.execPath, [launcher, "setup", flag], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, `${flag}: ${result.stderr}`);
    assert.match(result.stdout, /^Usage: granttap setup \[--engine <path>\]/);
    assert.match(result.stdout, /-h, --help/);
    assert.doesNotMatch(result.stdout, /Background helper|Phone pairing/);
    assert.equal(result.stderr, "");
  }
  assert.deepEqual(tree(directory), before, "help must not write hooks, helpers or configuration");
});
