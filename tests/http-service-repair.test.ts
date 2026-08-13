import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const packageRoot = join(import.meta.dirname, "..");
const executable = join(packageRoot, "bin", "granttap-mcp.mjs");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
    server.on("error", reject);
  });
}

function authorizeEnv(root: string, port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: join(root, "home"),
    GRANTTAP_CONFIG_DIR: join(root, "config"),
    GRANTTAP_CURSOR_DIR: join(root, "cursor"),
    GRANTTAP_LAUNCH_AGENTS_DIR: join(root, "LaunchAgents"),
    GRANTTAP_MCP_HTTP_HOST: "127.0.0.1",
    GRANTTAP_MCP_HTTP_PORT: String(port),
    GRANTTAP_NODE: process.execPath,
    GRANTTAP_HTTP_HEALTH_TIMEOUT_MS: "100",
  };
}

function ownedPlist(launcher = executable): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>', "<plist><dict>", "<key>Label</key>",
    "<string>com.granttap.mcp-http</string>", "<key>ProgramArguments</key>", "<array>",
    `<string>${launcher}</string>`, "<string>serve</string>", "</array>", "</dict></plist>", "",
  ].join("\n");
}

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable, ...args], { cwd: packageRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("authorize restores a pre-existing owned plist when repaired service health fails", async (t) => {
  if (process.platform !== "darwin") return t.skip("LaunchAgent is macOS-only");
  const root = mkdtempSync(join(tmpdir(), "granttap-http-rollback-health-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = {
    ...authorizeEnv(root, await freePort()),
    GRANTTAP_SKIP_LAUNCHCTL: "1",
  };
  const path = join(env.GRANTTAP_LAUNCH_AGENTS_DIR!, "com.granttap.mcp-http.plist");
  const before = ownedPlist("/previous/granttap-mcp.mjs");
  mkdirSync(env.GRANTTAP_LAUNCH_AGENTS_DIR!, { recursive: true });
  writeFileSync(path, before);
  const result = await run(["authorize"], env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /did not become healthy/);
  assert.equal(existsSync(path), true);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("authorize restores exact owned plist and loaded state after bootstrap fails", async (t) => {
  if (process.platform !== "darwin") return t.skip("LaunchAgent is macOS-only");
  const root = mkdtempSync(join(tmpdir(), "granttap-http-rollback-bootstrap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const port = await freePort();
  const fakeBin = join(root, "bin");
  const serviceState = join(root, "service-loaded");
  const failedOnce = join(root, "bootstrap-failed-once");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(serviceState, "loaded\n");
  writeFileSync(join(fakeBin, "launchctl"), [
    "#!/bin/sh", 'case "$1" in', '  print) test -f "$GRANTTAP_FAKE_SERVICE_STATE" ;;',
    '  bootout) rm -f "$GRANTTAP_FAKE_SERVICE_STATE"; exit 0 ;;', "  bootstrap)",
    '    if ! test -f "$GRANTTAP_FAKE_FAILED_ONCE"; then', '      touch "$GRANTTAP_FAKE_FAILED_ONCE"',
    '      echo "injected bootstrap failure" >&2', "      exit 1", "    fi",
    '    touch "$GRANTTAP_FAKE_SERVICE_STATE"', "    exit 0", "    ;;", "esac", "",
  ].join("\n"), { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    ...authorizeEnv(root, port), PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    GRANTTAP_FAKE_SERVICE_STATE: serviceState, GRANTTAP_FAKE_FAILED_ONCE: failedOnce,
  };
  const path = join(env.GRANTTAP_LAUNCH_AGENTS_DIR!, "com.granttap.mcp-http.plist");
  const before = ownedPlist();
  mkdirSync(env.GRANTTAP_LAUNCH_AGENTS_DIR!, { recursive: true });
  writeFileSync(path, before);
  const result = await run(["authorize"], env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /injected bootstrap failure/);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(existsSync(serviceState), true);
});

test("authorize leaves a foreign OAuth plist untouched", async (t) => {
  if (process.platform !== "darwin") return t.skip("LaunchAgent is macOS-only");
  const root = mkdtempSync(join(tmpdir(), "granttap-http-rollback-foreign-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = {
    ...authorizeEnv(root, await freePort()),
    GRANTTAP_SKIP_LAUNCHCTL: "1",
  };
  const path = join(env.GRANTTAP_LAUNCH_AGENTS_DIR!, "com.granttap.mcp-http.plist");
  const before = "foreign plist contents\n";
  mkdirSync(env.GRANTTAP_LAUNCH_AGENTS_DIR!, { recursive: true });
  writeFileSync(path, before);
  const result = await run(["authorize"], env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not an owned GrantTap HTTP service/);
  assert.equal(readFileSync(path, "utf8"), before);
});
