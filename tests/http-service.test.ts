import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  httpMcpLaunchAgentPath,
  inspectHttpMcpService,
  installHttpMcpService,
  isHttpMcpPortOccupied,
  probeHttpMcpHealth,
} from "../apps/mcp/src/http-service";
import { inspectCursorOAuthReadiness } from "../apps/mcp/src/provider-status";

const packageRoot = join(import.meta.dirname, "..");
const executable = join(packageRoot, "bin", "granttap-mcp.mjs");

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
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<plist><dict>",
    "<key>Label</key>",
    "<string>com.granttap.mcp-http</string>",
    "<key>ProgramArguments</key>",
    "<array>",
    `<string>${launcher}</string>`,
    "<string>internal</string>",
    "<string>serve</string>",
    "</array>",
    "</dict></plist>",
    "",
  ].join("\n");
}

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable, ...args], {
      cwd: packageRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !await condition()) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

test("authorize installs a persistent loopback service, verifies health, then exits", async (t) => {
  if (process.platform !== "darwin") return t.skip("LaunchAgent is macOS-only");
  const root = mkdtempSync(join(tmpdir(), "granttap-http-service-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const port = await freePort();
  const configDir = join(root, "config");
  const cursorDir = join(root, "cursor");
  const agentsDir = join(root, "LaunchAgents");
  const fakeBin = join(root, "bin");
  const pidFile = join(root, "http-service.pid");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "launchctl"), [
    "#!/bin/sh",
    'case "$1" in',
    "  print)",
    '    test -f "$GRANTTAP_FAKE_PID_FILE" || exit 1',
    '    kill -0 "$(cat "$GRANTTAP_FAKE_PID_FILE")" 2>/dev/null',
    "    ;;",
    "  bootout)",
    '    if test -f "$GRANTTAP_FAKE_PID_FILE"; then',
    '      old_pid="$(cat "$GRANTTAP_FAKE_PID_FILE")"',
    '      kill -TERM "$old_pid" 2>/dev/null || true',
    "      count=0",
    '      while kill -0 "$old_pid" 2>/dev/null && test "$count" -lt 40; do',
    "        sleep 0.05",
    "        count=$((count + 1))",
    "      done",
    '      rm -f "$GRANTTAP_FAKE_PID_FILE"',
    "    fi",
    "    exit 0",
    "    ;;",
    "  bootstrap)",
    '    "$GRANTTAP_FAKE_NODE" "$GRANTTAP_FAKE_LAUNCHER" internal serve >>"$GRANTTAP_FAKE_LOG" 2>&1 &',
    '    echo $! >"$GRANTTAP_FAKE_PID_FILE"',
    "    exit 0",
    "    ;;",
    "esac",
    "",
  ].join("\n"), { mode: 0o755 });
  const previous = {
    config: process.env.GRANTTAP_CONFIG_DIR,
    cursor: process.env.GRANTTAP_CURSOR_DIR,
    agents: process.env.GRANTTAP_LAUNCH_AGENTS_DIR,
    host: process.env.GRANTTAP_MCP_HTTP_HOST,
    port: process.env.GRANTTAP_MCP_HTTP_PORT,
    node: process.env.GRANTTAP_NODE,
    skip: process.env.GRANTTAP_SKIP_LAUNCHCTL,
    path: process.env.PATH,
    fakePid: process.env.GRANTTAP_FAKE_PID_FILE,
    fakeNode: process.env.GRANTTAP_FAKE_NODE,
    fakeLauncher: process.env.GRANTTAP_FAKE_LAUNCHER,
    fakeLog: process.env.GRANTTAP_FAKE_LOG,
  };
  Object.assign(process.env, {
    GRANTTAP_CONFIG_DIR: configDir,
    GRANTTAP_CURSOR_DIR: cursorDir,
    GRANTTAP_LAUNCH_AGENTS_DIR: agentsDir,
    GRANTTAP_MCP_HTTP_HOST: "127.0.0.1",
    GRANTTAP_MCP_HTTP_PORT: String(port),
    GRANTTAP_NODE: process.execPath,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    GRANTTAP_FAKE_PID_FILE: pidFile,
    GRANTTAP_FAKE_NODE: process.execPath,
    GRANTTAP_FAKE_LAUNCHER: executable,
    GRANTTAP_FAKE_LOG: join(root, "fake-service.log"),
  });
  delete process.env.GRANTTAP_SKIP_LAUNCHCTL;
  const stopFakeService = () => {
    try {
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (Number.isInteger(pid) && pid > 1) process.kill(pid, "SIGTERM");
    } catch {
      /* already stopped */
    }
  };
  t.after(stopFakeService);
  t.after(() => {
    for (const [key, value] of Object.entries({
      GRANTTAP_CONFIG_DIR: previous.config,
      GRANTTAP_CURSOR_DIR: previous.cursor,
      GRANTTAP_LAUNCH_AGENTS_DIR: previous.agents,
      GRANTTAP_MCP_HTTP_HOST: previous.host,
      GRANTTAP_MCP_HTTP_PORT: previous.port,
      GRANTTAP_NODE: previous.node,
      GRANTTAP_SKIP_LAUNCHCTL: previous.skip,
      PATH: previous.path,
      GRANTTAP_FAKE_PID_FILE: previous.fakePid,
      GRANTTAP_FAKE_NODE: previous.fakeNode,
      GRANTTAP_FAKE_LAUNCHER: previous.fakeLauncher,
      GRANTTAP_FAKE_LOG: previous.fakeLog,
    })) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const result = await run(["internal", "authorize"], { ...process.env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Persistent local OAuth is healthy/);
  assert.match(result.stderr, /Open Cursor Settings/);

  const plistPath = httpMcpLaunchAgentPath();
  const plist = readFileSync(plistPath, "utf8");
  assert.match(plist, /<string>com\.granttap\.mcp-http<\/string>/);
  assert.match(plist, /granttap-mcp\.mjs<\/string>\s*<string>internal<\/string>\s*<string>serve<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.doesNotMatch(plist, /Cursor\.app|\/helpers\/node/);
  assert.match(plist, new RegExp(`<string>${port}<\\/string>`));
  assert.deepEqual(inspectHttpMcpService(), { configured: true, running: true });
  assert.equal(installHttpMcpService().status, "already");
  const mcpUrl = `http://127.0.0.1:${port}/mcp`;
  assert.equal(await probeHttpMcpHealth(mcpUrl), true);
  assert.deepEqual(await inspectCursorOAuthReadiness(), {
    configured: true,
    persistent: true,
    healthy: true,
  });

  const cursor = JSON.parse(readFileSync(join(cursorDir, "mcp.json"), "utf8")) as {
    mcpServers: { granttap: { url: string } };
  };
  assert.equal(cursor.mcpServers.granttap.url, mcpUrl);

  writeFileSync(plistPath, plist.replace(executable, "/deleted/granttap-mcp/bin/granttap-mcp.mjs"));
  const setup = await run(["setup"], { ...process.env });
  assert.equal(setup.code, 0, setup.stderr);
  assert.match(setup.stdout, /Cursor\s+Beta · Authorize in Cursor/);
  assert.match(readFileSync(plistPath, "utf8"), /<string>internal<\/string>\s*<string>serve<\/string>/);

  stopFakeService();
  await waitFor(async () => !await probeHttpMcpHealth(mcpUrl, 100));
  await waitFor(() => !inspectHttpMcpService().running);
  assert.equal(await probeHttpMcpHealth(mcpUrl, 100), false);
  assert.deepEqual(await inspectCursorOAuthReadiness(), {
    configured: true,
    persistent: false,
    healthy: false,
  });

  const cursorBefore = readFileSync(join(cursorDir, "mcp.json"), "utf8");
  const plistBefore = readFileSync(plistPath, "utf8");
  const foreign = createServer((socket) => {
    socket.once("data", () => {
      const body = JSON.stringify({ ok: true, service: "not-granttap", mcp: mcpUrl });
      socket.end([
        "HTTP/1.1 200 OK",
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(body)}`,
        "Connection: close",
        "",
        body,
      ].join("\r\n"));
    });
  });
  await new Promise<void>((resolve, reject) => {
    foreign.once("error", reject);
    foreign.listen(port, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => foreign.close(() => resolve())));
  assert.equal(await isHttpMcpPortOccupied(mcpUrl), true);
  const collision = await run(["internal", "authorize"], {
    ...process.env,
    GRANTTAP_HTTP_HEALTH_TIMEOUT_MS: "200",
  });
  assert.equal(collision.code, 1);
  assert.match(collision.stderr, /another process owns/);
  assert.equal(readFileSync(join(cursorDir, "mcp.json"), "utf8"), cursorBefore);
  assert.equal(readFileSync(plistPath, "utf8"), plistBefore);
  assert.equal(await isHttpMcpPortOccupied(mcpUrl), true, "foreign listener remains untouched");
  await new Promise<void>((resolve) => foreign.close(() => resolve()));
});
