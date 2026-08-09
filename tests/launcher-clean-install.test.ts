import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const sourceRoot = join(import.meta.dirname, "..");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
    server.on("error", reject);
  });
}

test("published launcher resolves hoisted dependencies and runs setup/serve in isolation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-hoisted-launcher-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const modules = join(project, "node_modules");
  const installed = join(modules, "granttap-mcp");
  const binDir = join(modules, ".bin");
  const isolated = join(root, "isolated");
  mkdirSync(installed, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  for (const path of ["apps", "bin", "packages", "package.json"]) {
    cpSync(join(sourceRoot, path), join(installed, path), { recursive: true });
  }
  const packageJson = JSON.parse(
    readFileSync(join(sourceRoot, "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  for (const dependency of Object.keys(packageJson.dependencies)) {
    const source = join(sourceRoot, "node_modules", dependency);
    assert.ok(existsSync(source), `${dependency} must be installed for this regression test`);
    const target = join(modules, dependency);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(source, target);
  }
  symlinkSync("../granttap-mcp/bin/granttap-mcp.mjs", join(binDir, "granttap"));
  for (const path of ["home", "config", "cursor", "claude", "codex", "agents"]) {
    mkdirSync(join(isolated, path), { recursive: true });
  }
  assert.equal(existsSync(join(installed, "node_modules")), false, "dependency must stay hoisted");
  const before = readdirSync(isolated, { recursive: true }).map(String).sort();
  const env = {
    ...process.env,
    HOME: join(isolated, "home"),
    GRANTTAP_CONFIG_DIR: join(isolated, "config"),
    NODVOX_CONFIG_DIR: join(isolated, "legacy-config"),
    GRANTTAP_CURSOR_DIR: join(isolated, "cursor"),
    GRANTTAP_CURSOR_MCP_CONFIG: join(isolated, "cursor", "mcp.json"),
    GRANTTAP_CLAUDE_DIR: join(isolated, "claude"),
    GRANTTAP_CODEX_DIR: join(isolated, "codex"),
    GRANTTAP_LAUNCH_AGENTS_DIR: join(isolated, "agents"),
    GRANTTAP_PINNED_MONITOR_BIN: join(isolated, "missing-nodvox-monitor"),
    GRANTTAP_PINNED_MONITOR_ROOT: join(isolated, "missing-nodvox-root"),
    GRANTTAP_MONITOR_CWD: join(isolated, "workspace"),
    GRANTTAP_NODE: process.execPath,
    GRANTTAP_SKIP_LAUNCHCTL: "1",
  };
  const run = (args: string[]) => spawnSync(join(binDir, "granttap"), args, {
    cwd: project,
    env,
    encoding: "utf8",
  });

  const help = run(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /granttap status \[--json\]/);
  const status = run(["status", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stderr, "");
  const snapshot = JSON.parse(status.stdout) as {
    schema: string;
    providers: Array<{ id: string }>;
  };
  assert.equal(snapshot.schema, "granttap.provider-status.v1");
  assert.deepEqual(snapshot.providers.map((provider) => provider.id), [
    "cursor", "claude", "codex", "web",
  ]);
  assert.doesNotMatch(status.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(readdirSync(isolated, { recursive: true }).map(String).sort(), before);
  assert.equal(dirname(installed), modules);

  const setup = run(["setup"]);
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /^Cursor: installed/m);
  assert.match(setup.stdout, /Claude Code: installed/);
  assert.match(setup.stdout, /Codex: action required/);
  const cursorHooks = readFileSync(join(isolated, "cursor", "hooks.json"), "utf8");
  for (const route of ["cursor", "cursor-after", "cursor-mcp"]) {
    assert.match(cursorHooks, new RegExp(`hook ${route}`));
  }

  const port = await freePort();
  const serveEnv = {
    ...env,
    GRANTTAP_MCP_HTTP_HOST: "127.0.0.1",
    GRANTTAP_MCP_HTTP_PORT: String(port),
  };
  const serve = spawn(join(binDir, "granttap"), ["serve"], {
    cwd: project,
    env: serveEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serveStderr = "";
  serve.stderr.on("data", (chunk: Buffer) => { serveStderr += chunk.toString("utf8"); });
  t.after(() => serve.kill("SIGTERM"));
  let health: Response | null = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      health = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (health.ok) break;
    } catch {
      // The portable launcher may still be resolving its TypeScript loader.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(health?.ok, serveStderr);
  const healthJson = await health!.json() as { schema: string; service: string };
  assert.equal(healthJson.schema, "granttap.http-health.v1");
  assert.equal(healthJson.service, "granttap-mcp");
  serve.kill("SIGTERM");
  const exit = await new Promise<number | null>((resolve) => serve.once("exit", resolve));
  assert.equal(exit, 0, serveStderr);
});
