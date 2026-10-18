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
import { createHttpServiceFixture } from "../support/http-service/fixture";
import {
  httpMcpLaunchAgentPath,
  inspectHttpMcpService,
  installHttpMcpService,
  isHttpMcpPortOccupied,
  probeHttpMcpHealth,
} from "../../apps/mcp/src/http-service";
import { inspectCursorOAuthReadiness } from "../../apps/mcp/src/status/provider-status";

const packageRoot = join(import.meta.dirname, "../..");
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
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !await condition()) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

test("authorize installs a persistent loopback service, verifies health, then exits", async (t) => {
  if (process.platform !== "darwin") return t.skip("LaunchAgent is macOS-only");
  const root = mkdtempSync(join(tmpdir(), "granttap-http-service-"));
  const port = await freePort();
  const { cursorDir, pidFile, stopFakeService } = createHttpServiceFixture(t, root, port, executable);

  mkdirSync(cursorDir, { recursive: true });
  writeFileSync(join(cursorDir, "mcp.json"), `${JSON.stringify({
    mcpServers: {
      github: { command: "github-mcp" },
      granttap: { url: `http://127.0.0.1:${port}/mcp` },
    },
  }, null, 2)}\n`);
  const result = await run(["internal", "authorize"], {
    ...process.env,
    GRANTTAP_HTTP_HEALTH_TIMEOUT_MS: "30000",
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Persistent local helper is healthy/);
  assert.match(result.stderr, /Use the GrantTap plugin/);

  const plistPath = httpMcpLaunchAgentPath();
  const plist = readFileSync(plistPath, "utf8");
  assert.match(plist, /<string>com\.granttap\.mcp-http<\/string>/);
  assert.match(plist, /granttap-mcp\.mjs<\/string>\s*<string>internal<\/string>\s*<string>serve<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>ProcessType<\/key>\s*<string>Interactive<\/string>/);
  assert.doesNotMatch(plist, /Cursor\.app|\/helpers\/node/);
  assert.match(plist, new RegExp(`<string>${port}<\\/string>`));
  const packageVersion = (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string }).version;
  assert.match(plist, new RegExp(`<key>GRANTTAP_PACKAGE_VERSION<\\/key>\\s*<string>${packageVersion.replaceAll(".", "\\.")}<\\/string>`));
  assert.deepEqual(inspectHttpMcpService(), { configured: true, running: true });
  assert.equal(installHttpMcpService().status, "already");
  const previousPid = readFileSync(pidFile, "utf8");
  writeFileSync(plistPath, plist.replace(`<string>${packageVersion}</string>`, "<string>0.0.0</string>"));
  const upgraded = await run(["setup"], { ...process.env });
  assert.equal(upgraded.code, 0, upgraded.stderr);
  assert.notEqual(readFileSync(pidFile, "utf8"), previousPid);
  assert.equal(readFileSync(plistPath, "utf8"), plist);
  const mcpUrl = `http://127.0.0.1:${port}/mcp`;
  await waitFor(() => probeHttpMcpHealth(mcpUrl));
  assert.equal(await probeHttpMcpHealth(mcpUrl), true);
  assert.deepEqual(await inspectCursorOAuthReadiness(), {
    configured: false,
    persistent: false,
    healthy: false,
  });

  const cursor = JSON.parse(readFileSync(join(cursorDir, "mcp.json"), "utf8")) as {
    mcpServers: Record<string, unknown>;
  };
  assert.equal(cursor.mcpServers.granttap, undefined);
  assert.deepEqual(cursor.mcpServers.github, { command: "github-mcp" });

  writeFileSync(plistPath, plist.replace(executable, "/deleted/granttap-mcp/bin/granttap-mcp.mjs"));
  const setup = await run(["setup"], { ...process.env });
  assert.equal(setup.code, 0, setup.stderr);
  assert.match(setup.stdout, /Cursor\s+Beta · Use GrantTap plugin/);
  assert.match(readFileSync(plistPath, "utf8"), /<string>internal<\/string>\s*<string>serve<\/string>/);

  await stopFakeService();
  await waitFor(async () => !await probeHttpMcpHealth(mcpUrl, 100));
  await waitFor(() => !inspectHttpMcpService().running);
  assert.equal(await probeHttpMcpHealth(mcpUrl, 100), false);
  assert.deepEqual(await inspectCursorOAuthReadiness(), {
    configured: false,
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
