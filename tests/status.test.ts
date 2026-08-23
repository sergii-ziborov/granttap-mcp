import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
      { agent: "grok", installed: true, hookConfigured: false },
    ],
    paired: true,
    monitor: { configured: true, running: true },
  });
  assert.deepEqual(providers.map((provider) => provider.id), ["cursor", "claude", "codex", "grok"]);
  assert.equal(providers[0]?.status, "connected");
  assert.match(providers[0]?.detail ?? "", /Run granttap setup for Cursor authorization/);
  assert.equal(providers[1]?.status, "connected");
  assert.equal(providers[2]?.status, "action_required");
  assert.match(providers[2]?.detail ?? "", /\/hooks/);
  assert.equal(providers[3]?.status, "connected");

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
  assert.match(deadOAuth[0]?.detail ?? "", /needs repair/);
  const liveOAuth = providerStatuses({
    ...oauthBase,
    cursorOAuth: { configured: true, persistent: true, healthy: true },
  });
  assert.equal(liveOAuth[0]?.status, "connected");
  assert.match(liveOAuth[0]?.detail ?? "", /persistent OAuth endpoint/);
});

test("status snapshots contain no pairing secrets or private capability", (t) => {
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

  const serialized = JSON.stringify(inspectProviderStatusSnapshot(new Date(0)));
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
  for (const command of ["setup", "connect", "status", "reset"]) {
    assert.match(help.stdout, new RegExp(`granttap ${command}\\b`));
  }
  for (const command of ["login", "relogin", "logout", "account-status", "web", "serve", "monitor", "hook", "authorize"]) {
    assert.doesNotMatch(help.stdout, new RegExp(`granttap ${command}\\b`));
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
    ["cursor", "claude", "codex", "grok"],
  );
  assert.deepEqual(readdirSync(root, { recursive: true }).map(String).sort(), before);
});
