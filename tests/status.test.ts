import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  inspectProviderStatusSnapshot,
  inspectWebReadiness,
  providerStatuses,
} from "../apps/mcp/src/provider-status";

const packageRoot = join(import.meta.dirname, "..");
const executable = join(packageRoot, "bin", "granttap-mcp.mjs");

test("provider status requires the full hook set, live pairing, and monitor", () => {
  const providers = providerStatuses({
    cursor: { installed: true, hookConfigured: true },
    integrations: [
      { agent: "claude", installed: true, hookConfigured: true },
      { agent: "codex", installed: true, hookConfigured: true },
    ],
    paired: true,
    monitor: { configured: true, running: true },
  });
  assert.deepEqual(providers.map((provider) => provider.id), ["cursor", "claude", "codex", "web"]);
  assert.equal(providers[0]?.status, "connected");
  assert.match(providers[0]?.detail ?? "", /OAuth remains optional/);
  assert.equal(providers[1]?.status, "connected");
  assert.equal(providers[2]?.status, "action_required");
  assert.match(providers[2]?.detail ?? "", /\/hooks/);
  assert.equal(providers[3]?.status, "not_configured");

  const webReady = providerStatuses({
    cursor: { installed: true, hookConfigured: true },
    integrations: [],
    paired: true,
    monitor: { configured: true, running: true },
    web: { configured: true, reachable: true },
  });
  assert.equal(webReady[3]?.status, "connected");
  assert.match(webReady[3]?.detail ?? "", /granttap web/);
  const webOffline = providerStatuses({
    cursor: { installed: true, hookConfigured: true },
    integrations: [],
    paired: true,
    monitor: { configured: true, running: true },
    web: { configured: true, reachable: false },
  });
  assert.equal(webOffline[3]?.status, "action_required");
  assert.match(webOffline[3]?.detail ?? "", /relay did not answer/);

  const stopped = providerStatuses({
    cursor: { installed: true, hookConfigured: false },
    integrations: [{ agent: "claude", installed: true, hookConfigured: true }],
    paired: true,
    monitor: { configured: true, running: false },
  });
  assert.equal(stopped[0]?.status, "action_required");
  assert.match(stopped[0]?.detail ?? "", /install or repair/);
  assert.equal(stopped[1]?.status, "action_required");
  assert.match(stopped[1]?.detail ?? "", /not running/);

  const oauthBase = {
    cursor: { installed: true, hookConfigured: true },
    integrations: [] as Array<{ agent: "claude" | "codex"; installed: boolean; hookConfigured: boolean }>,
    paired: true,
    monitor: { configured: true, running: true },
  };
  const deadOAuth = providerStatuses({
    ...oauthBase,
    cursorOAuth: { configured: true, persistent: true, healthy: false },
  });
  assert.equal(deadOAuth[0]?.status, "action_required");
  assert.match(deadOAuth[0]?.detail ?? "", /not healthy/);
  const liveOAuth = providerStatuses({
    ...oauthBase,
    cursorOAuth: { configured: true, persistent: true, healthy: true },
  });
  assert.equal(liveOAuth[0]?.status, "connected");
  assert.match(liveOAuth[0]?.detail ?? "", /persistent OAuth endpoint/);
});

test("status live probe is truthful while snapshots contain no private capability", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-status-safe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const cursorDir = join(root, "cursor");
  const claudeDir = join(root, "claude");
  const codexDir = join(root, "codex");
  const launchAgents = join(root, "LaunchAgents");
  for (const dir of [configDir, cursorDir, claudeDir, codexDir, launchAgents]) {
    mkdirSync(dir, { recursive: true });
  }
  const room = "ab".repeat(16);
  const secret = "secret-key-that-must-never-be-printed";
  const pushAuth = "cd".repeat(32);
  const storedPrivateUrl = "https://relay.example/a/room/stored-private-token";
  writeFileSync(join(configDir, "machine.json"), JSON.stringify({
    room,
    relayUrl: "wss://relay.example/ws",
    mySecretKey: secret,
    peerPublicKey: "peer-key-that-must-never-be-printed",
    pushAuth,
    privatePageUrl: storedPrivateUrl,
  }));
  const previous = {
    config: process.env.GRANTTAP_CONFIG_DIR,
    cursor: process.env.GRANTTAP_CURSOR_DIR,
    claude: process.env.GRANTTAP_CLAUDE_DIR,
    codex: process.env.GRANTTAP_CODEX_DIR,
    agents: process.env.GRANTTAP_LAUNCH_AGENTS_DIR,
  };
  Object.assign(process.env, {
    GRANTTAP_CONFIG_DIR: configDir,
    GRANTTAP_CURSOR_DIR: cursorDir,
    GRANTTAP_CLAUDE_DIR: claudeDir,
    GRANTTAP_CODEX_DIR: codexDir,
    GRANTTAP_LAUNCH_AGENTS_DIR: launchAgents,
  });
  t.after(() => {
    for (const [key, value] of Object.entries({
      GRANTTAP_CONFIG_DIR: previous.config,
      GRANTTAP_CURSOR_DIR: previous.cursor,
      GRANTTAP_CLAUDE_DIR: previous.claude,
      GRANTTAP_CODEX_DIR: previous.codex,
      GRANTTAP_LAUNCH_AGENTS_DIR: previous.agents,
    })) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const unreachable = await inspectWebReadiness((async () => {
    throw new Error("offline");
  }) as typeof fetch);
  assert.deepEqual(unreachable, { configured: true, reachable: false });
  const foreignPage = await inspectWebReadiness((async () => Response.json({
    ok: true,
    pageUrl: "https://evil.example/a/stolen",
    approvals: [],
  })) as typeof fetch);
  assert.deepEqual(foreignPage, { configured: true, reachable: false });
  const reachable = await inspectWebReadiness((async (_input, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${pushAuth}`);
    return Response.json({
      ok: true,
      pageUrl: "https://relay.example/a/room/live-private-token",
      approvals: [],
    });
  }) as typeof fetch);
  assert.deepEqual(reachable, { configured: true, reachable: true });

  const serialized = JSON.stringify(inspectProviderStatusSnapshot(new Date(0), reachable));
  assert.doesNotMatch(serialized, new RegExp(room));
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, new RegExp(pushAuth));
  assert.doesNotMatch(serialized, /stored-private-token|live-private-token|evil\.example/);
  assert.doesNotMatch(serialized, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("public granttap bin exposes management routes and emits compatible JSON read-only", (t) => {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    bin: Record<string, string>;
  };
  assert.equal(packageJson.bin.granttap, "bin/granttap-mcp.mjs");
  assert.equal(packageJson.bin["granttap-mcp"], packageJson.bin.granttap);
  assert.doesNotThrow(() => accessSync(executable, constants.X_OK));

  const help = spawnSync(process.execPath, [executable, "--help"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);
  for (const command of ["authorize", "setup", "connect", "status", "web"]) {
    assert.match(help.stdout, new RegExp(`granttap ${command}\\b`));
  }

  const root = mkdtempSync(join(tmpdir(), "granttap-status-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["config", "cursor", "claude", "codex", "agents"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  const before = readdirSync(root, { recursive: true }).map(String).sort();
  const status = spawnSync(process.execPath, [executable, "status", "--json"], {
    cwd: packageRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: "",
      GRANTTAP_CONFIG_DIR: join(root, "config"),
      GRANTTAP_CURSOR_DIR: join(root, "cursor"),
      GRANTTAP_CLAUDE_DIR: join(root, "claude"),
      GRANTTAP_CODEX_DIR: join(root, "codex"),
      GRANTTAP_LAUNCH_AGENTS_DIR: join(root, "agents"),
    },
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stderr, "");
  const snapshot = JSON.parse(status.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(snapshot).sort(), ["generatedAt", "providers", "schema"]);
  assert.equal(snapshot.schema, "granttap.provider-status.v1");
  assert.deepEqual(
    (snapshot.providers as Array<{ id: string }>).map((provider) => provider.id),
    ["cursor", "claude", "codex", "web"],
  );
  assert.deepEqual(readdirSync(root, { recursive: true }).map(String).sort(), before);
});

test("web reveals its capability only explicitly while status performs a secret-safe live probe", async (t) => {
  const room = "12".repeat(16);
  const pushAuth = "34".repeat(32);
  const privateToken = "private-view-token-must-not-enter-status";
  const server = createServer((request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.headers.authorization, `Bearer ${pushAuth}`);
    assert.match(request.url ?? "", new RegExp(`^/approvals\\?room=${room}$`));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      ok: true,
      pageUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/a/${room}/${privateToken}`,
      approvals: [],
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const root = mkdtempSync(join(tmpdir(), "granttap-web-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["config", "cursor", "claude", "codex", "agents"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, "config", "machine.json"), JSON.stringify({
    relayUrl: `ws://127.0.0.1:${port}`,
    room,
    role: "machine",
    deviceName: "local-test",
    senderId: "local-test",
    myPublicKey: "machine-public-key",
    mySecretKey: "machine-secret-key",
    peerPublicKey: "phone-public-key",
    pushAuth,
  }));
  const env = {
    ...process.env,
    PATH: "",
    GRANTTAP_CONFIG_DIR: join(root, "config"),
    GRANTTAP_CURSOR_DIR: join(root, "cursor"),
    GRANTTAP_CLAUDE_DIR: join(root, "claude"),
    GRANTTAP_CODEX_DIR: join(root, "codex"),
    GRANTTAP_LAUNCH_AGENTS_DIR: join(root, "agents"),
  };
  const run = (args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [executable, ...args], {
        cwd: packageRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });

  const web = await run(["web"]);
  assert.equal(web.code, 0, web.stderr);
  assert.equal(web.stderr, "");
  assert.match(web.stdout, /private capability/i);
  assert.match(web.stdout, new RegExp(privateToken));
  assert.match(web.stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}/a/`));

  const status = await run(["status", "--json"]);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.stderr, "");
  const snapshot = JSON.parse(status.stdout) as {
    providers: Array<{ id: string; status: string; detail: string }>;
  };
  assert.equal(snapshot.providers.find((provider) => provider.id === "web")?.status, "connected");
  for (const privateValue of [privateToken, pushAuth, room, String(port), root]) {
    assert.equal(status.stdout.includes(privateValue), false, `status leaked ${privateValue}`);
  }
});
