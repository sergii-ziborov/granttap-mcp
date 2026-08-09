import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CODEX_TRUST_INSTRUCTION,
  hookCommand,
  inspectCursorIntegration,
  installClaudeHook,
  installCodexHook,
  installCursorHook,
} from "../apps/bridge/src/install";

test("setup copy requires explicit Codex hook review and trust", () => {
  assert.match(CODEX_TRUST_INSTRUCTION, /\/hooks/);
  assert.match(CODEX_TRUST_INSTRUCTION, /review and trust/);
});

test("setup repairs an existing Claude GrantTap matcher for Skill tools", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-claude-repair-"));
  await mkdir(root, { recursive: true });
  const path = join(root, "settings.json");
  await writeFile(path, JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__.*",
        hooks: [{ type: "command", command: hookCommand("claude"), timeout: 120 }],
      }],
    },
  }));
  const previous = process.env.GRANTTAP_CLAUDE_DIR;
  process.env.GRANTTAP_CLAUDE_DIR = root;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CLAUDE_DIR;
    else process.env.GRANTTAP_CLAUDE_DIR = previous;
  });

  assert.equal(installClaudeHook().status, "installed");
  const repaired = JSON.parse(await readFile(path, "utf8")) as {
    hooks: { PreToolUse: Array<{ matcher: string }> };
  };
  assert.match(repaired.hooks.PreToolUse[0]!.matcher, /(?:^|\|)Skill(?:\||$)/);
  assert.match(repaired.hooks.PreToolUse[0]!.matcher, /(?:^|\|)skill__\.\*(?:\||$)/);
  assert.equal(installClaudeHook().status, "already");
});

test("setup accepts Codex hooks default-on and repairs an explicit feature disable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-codex-repair-"));
  await mkdir(root, { recursive: true });
  const path = join(root, "config.toml");
  const previous = process.env.GRANTTAP_CODEX_DIR;
  process.env.GRANTTAP_CODEX_DIR = root;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CODEX_DIR;
    else process.env.GRANTTAP_CODEX_DIR = previous;
  });

  await writeFile(path, "[features]\nsome_other_feature = true\n");
  assert.equal(installCodexHook().status, "installed");
  const defaultOn = await readFile(path, "utf8");
  assert.match(defaultOn, /\[\[hooks\.PermissionRequest\]\]/);
  assert.match(defaultOn, /\[\[hooks\.PreToolUse\]\]/);
  assert.match(defaultOn, /hook codex-policy/);
  assert.doesNotMatch(defaultOn, /^\s*hooks\s*=\s*true/m);
  assert.equal(installCodexHook().status, "already");

  await writeFile(path, [
    "[features]",
    "hooks = false # disabled locally",
    "[[hooks.PermissionRequest]]",
    'matcher = ".*"',
    "[[hooks.PermissionRequest.hooks]]",
    `command = '${hookCommand("codex")}'`,
    "timeout = 120",
    "",
  ].join("\n"));
  assert.equal(installCodexHook().status, "installed");
  assert.match(await readFile(path, "utf8"), /^\s*hooks\s*=\s*true\s*# disabled locally$/m);
  assert.equal(installCodexHook().status, "already");
});

test("setup repairs the full Cursor hook set without fail-closing the editor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-cursor-repair-"));
  await mkdir(root, { recursive: true });
  const path = join(root, "hooks.json");
  await writeFile(path, JSON.stringify({
    version: 1,
    hooks: {
      beforeShellExecution: [{
        command: 'node "/deleted/granttap/bin/granttap-mcp.mjs" hook cursor',
        failClosed: true,
      }],
      beforeMCPExecution: [{ command: "unrelated-mcp-policy", failClosed: true }],
    },
  }));
  const previous = process.env.GRANTTAP_CURSOR_DIR;
  process.env.GRANTTAP_CURSOR_DIR = root;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CURSOR_DIR;
    else process.env.GRANTTAP_CURSOR_DIR = previous;
  });

  assert.equal(installCursorHook().status, "installed");
  const repaired = JSON.parse(await readFile(path, "utf8")) as {
    version: number;
    hooks: Record<string, Array<{ command: string; timeout?: number; failClosed?: boolean }>>;
  };
  assert.equal(repaired.version, 1);
  assert.equal(repaired.hooks.beforeShellExecution?.[0]?.command, hookCommand("cursor"));
  assert.equal(repaired.hooks.afterShellExecution?.[0]?.command, hookCommand("cursor-after"));
  assert.equal(repaired.hooks.beforeShellExecution?.[0]?.timeout, 120);
  assert.equal(repaired.hooks.afterShellExecution?.[0]?.timeout, 30);
  assert.equal(
    repaired.hooks.beforeMCPExecution?.find((entry) => entry.command === hookCommand("cursor-mcp"))
      ?.failClosed,
    false,
  );
  assert.ok(
    repaired.hooks.beforeMCPExecution?.some((entry) => entry.command === "unrelated-mcp-policy"),
    "unrelated Cursor hooks must be preserved",
  );
  assert.deepEqual(inspectCursorIntegration(), { installed: true, hookConfigured: true });
  assert.equal(installCursorHook().status, "already");

  repaired.hooks.beforeShellExecution![0]!.timeout = 1;
  await writeFile(path, JSON.stringify(repaired));
  assert.deepEqual(inspectCursorIntegration(), { installed: true, hookConfigured: false });
  assert.equal(installCursorHook().status, "installed");
  const timeoutRepaired = JSON.parse(await readFile(path, "utf8")) as typeof repaired;
  assert.equal(timeoutRepaired.hooks.beforeShellExecution?.[0]?.timeout, 120);

  timeoutRepaired.version = 2;
  const unsupported = JSON.stringify(timeoutRepaired);
  await writeFile(path, unsupported);
  assert.equal(installCursorHook().status, "manual");
  assert.equal(await readFile(path, "utf8"), unsupported);
});
