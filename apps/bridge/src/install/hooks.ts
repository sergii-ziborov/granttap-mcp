/**
 * Auto-registration of the agent hooks — the part that used to be "copy this
 * snippet into your config yourself".
 *
 *   Claude Code  ~/.claude/settings.json   hooks.PreToolUse
 *   Codex        ~/.codex/config.toml      [features] hooks + [[hooks.PermissionRequest]]
 *
 * Rules: back the file up once before first touching it, never register twice
 * (any existing "granttap" hook counts), and if a TOML merge would be ambiguous,
 * say so instead of corrupting the file.
 */
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolveClaudeBinary } from "../providers/claude-bin";
import { describeCommand, inspectTools, updatingTools } from "../tools/updater";
import { resolveCursorAgentBin } from "../reply/process/cursor-agent-bin";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { CodingAgent } from "../../../../packages/protocol/schema";
import {
  CLOBBER_LIVE_HELPER_DETAIL,
  insideTemporaryDirectory,
  plistUsesTemporaryIO,
  refusesClobberingLiveHelper,
  refusesLiveLaunchd,
} from "./launchd-safety";
import { configDir, loadRuntimeConfig, verifiableEngine } from "../config";
import { isCursorHelperNode, resolveMonitorNodeBin } from "../config/runtime/node-bin";
import { inspectWindowsTask, installWindowsTask } from "./windows-service";
import {
  type HookRoute,
  type InstallResult,
  CLAUDE_MATCHERS,
  commandHasRoute,
  hookCommand,
  codexHookSet,
} from "./inspect";

export { isCursorHelperNode, resolveMonitorNodeBin };

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function backupOnce(path: string): void {
  const bak = path + ".bak-granttap";
  if (existsSync(path) && !existsSync(bak)) copyFileSync(path, bak);
}

// ---------------------------------------------------------------- Claude Code

function repairClaudeMatcher(entry: { matcher?: unknown }): boolean {
  const values = typeof entry.matcher === "string"
    ? entry.matcher.split("|").map((value) => value.trim()).filter(Boolean)
    : [];
  let changed = typeof entry.matcher !== "string";
  for (const matcher of CLAUDE_MATCHERS) {
    if (!values.includes(matcher)) {
      values.push(matcher);
      changed = true;
    }
  }
  if (changed) entry.matcher = values.join("|");
  return changed;
}

export function installClaudeHook(): InstallResult {
  const dir =
    process.env.GRANTTAP_CLAUDE_DIR ??
    process.env.NODVOX_CLAUDE_DIR ??
    join(homedir(), ".claude");
  const path = join(dir, "settings.json");
  mkdirSync(dir, { recursive: true });

  let settings: any = {};
  if (existsSync(path)) {
    try {
      settings = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return { status: "manual", detail: `${path} — не парсится как JSON, не трогаю. Добавь hook вручную.` };
    }
  }

  // The prompt hook rides along with the approval hook: what the chat could
  // not know by itself — background runs in it, the Mesh around it — is added
  // to each prompt. It never blocks; anything wrong, and it adds nothing.
  const promptHookChanged = ensureClaudePromptHook(settings);
  const entries: any[] = (((settings.hooks ??= {}).PreToolUse ??= []) as any[]);
  const currentCommand = hookCommand("claude");
  const presentEntry = entries.find((entry) =>
    (entry?.hooks ?? []).some(
      (hook: any) => commandHasRoute(hook?.command, "claude"),
    ),
  );
  const present = presentEntry?.hooks?.find(
    (hook: any) => commandHasRoute(hook?.command, "claude"),
  );
  if (present && presentEntry) {
    const matcherChanged = repairClaudeMatcher(presentEntry);
    const commandChanged = present.command !== currentCommand;
    if (!matcherChanged && !commandChanged && !promptHookChanged) return { status: "already", detail: path };
    backupOnce(path);
    present.command = currentCommand;
    writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
    const detail = !matcherChanged && !commandChanged
      ? `${path}, GrantTap prompt hook added`
      : `${path}, GrantTap hook and matcher repaired`;
    return { status: "installed", detail };
  }

  const legacyEntry = entries.find((entry) =>
    (entry?.hooks ?? []).some((hook: any) =>
      typeof hook?.command === "string"
      && (hook.command.includes("bin/nodvox.mjs") || /\bnpx\s+(?:-y\s+)?nodvox\b/.test(hook.command)),
    ),
  );
  const legacy = legacyEntry?.hooks?.find((hook: any) =>
    typeof hook?.command === "string"
    && (hook.command.includes("bin/nodvox.mjs") || /\bnpx\s+(?:-y\s+)?nodvox\b/.test(hook.command)),
  );
  if (legacy && legacyEntry) {
    backupOnce(path);
    legacy.command = hookCommand("claude");
    repairClaudeMatcher(legacyEntry);
    writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
    return { status: "installed", detail: `${path}, обновлён Nodvox → GrantTap` };
  }

  backupOnce(path);
  entries.push({
    matcher: CLAUDE_MATCHERS.join("|"),
    hooks: [{ type: "command", command: hookCommand("claude"), timeout: 120 }],
  });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  return { status: "installed", detail: path };
}

/** Make sure the UserPromptSubmit hook is registered once, at the current command. */
function ensureClaudePromptHook(settings: any): boolean {
  const entries: any[] = (((settings.hooks ??= {}).UserPromptSubmit ??= []) as any[]);
  const command = hookCommand("claude-prompt");
  const present = entries
    .flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : []))
    .find((hook: any) => commandHasRoute(hook?.command, "claude-prompt"));
  if (present) {
    if (present.command === command) return false;
    present.command = command;
    return true;
  }
  entries.push({ hooks: [{ type: "command", command, timeout: 10 }] });
  return true;
}

// --------------------------------------------------------------------- Codex

function rewriteDisabledCodexHooks(config: string): { config: string; changed: boolean } {
  let inFeatures = false;
  let changed = false;
  const lines = config.split("\n").map((line) => {
    if (/^\s*\[features\]\s*(?:#.*)?$/i.test(line)) {
      inFeatures = true;
      return line;
    }
    if (/^\s*\[/.test(line)) {
      inFeatures = false;
      return line;
    }
    if (!inFeatures) return line;
    const repaired = line.replace(
      /^(\s*(?:hooks|codex_hooks)\s*=\s*)false(\s*(?:#.*)?)$/i,
      "$1true$2",
    );
    if (repaired !== line) changed = true;
    return repaired;
  });
  return { config: lines.join("\n"), changed };
}

export function codexHooksExplicitlyDisabled(config: string): boolean {
  return rewriteDisabledCodexHooks(config).changed;
}

export function installCodexHook(): InstallResult {
  const dir =
    process.env.GRANTTAP_CODEX_DIR ??
    process.env.NODVOX_CODEX_DIR ??
    join(homedir(), ".codex");
  const path = join(dir, "config.toml");
  mkdirSync(dir, { recursive: true });

  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  let next = existing;
  let changed = false;
  next = next.split(/\r?\n/).map((line) => {
    const match = line.match(/^(\s*command\s*=\s*)(["'])(.*)\2\s*(?:#.*)?$/);
    if (!match) return line;
    for (const route of ["codex", "codex-policy"] as const) {
      if (!commandHasRoute(match[3], route)) continue;
      const replacement = `${match[1]}'${hookCommand(route)}'`;
      if (replacement !== line) changed = true;
      return replacement;
    }
    return line;
  }).join("\n").replace(/^# nodvox —/gm, "# GrantTap —");

  const repaired = rewriteDisabledCodexHooks(next);
  next = repaired.config;
  changed ||= repaired.changed;
  const permissionBlock = [
    "",
    "# granttap — approvals from your phone/watch",
    "[[hooks.PermissionRequest]]",
    'matcher = ".*"',
    "[[hooks.PermissionRequest.hooks]]",
    'type = "command"',
    `command = '${hookCommand("codex")}'`,
    "timeout = 120",
    "",
  ].join("\n");
  const policyBlock = [
    "",
    "# granttap — deterministic per-chat MCP / skill / CLI switches",
    "[[hooks.PreToolUse]]",
    'matcher = ".*"',
    "[[hooks.PreToolUse.hooks]]",
    'type = "command"',
    `command = '${hookCommand("codex-policy")}'`,
    "timeout = 30",
    "",
  ].join("\n");
  const hooks = codexHookSet(next);
  if (!hooks.permission) {
    next += permissionBlock;
    changed = true;
  }
  if (!hooks.policy) {
    next += policyBlock;
    changed = true;
  }
  if (!changed) return { status: "already", detail: path };
  backupOnce(path);
  writeFileSync(path, next);
  return {
    status: "installed",
    detail: `${path}; open /hooks and trust both GrantTap hooks`,
  };
}

// --------------------------------------------------------------------- Cursor

export function installCursorHook(): InstallResult {
  const dir = process.env.GRANTTAP_CURSOR_DIR
    ?? process.env.NODVOX_CURSOR_DIR
    ?? join(homedir(), ".cursor");
  const path = join(dir, "hooks.json");
  mkdirSync(dir, { recursive: true });
  let document: {
    version?: number;
    hooks?: Record<string, Array<{
      command?: string;
      timeout?: number;
      failClosed?: boolean;
    }>>;
  } = { version: 1, hooks: {} };
  if (existsSync(path)) {
    try {
      document = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return {
        status: "manual",
        detail: `${path} is invalid JSON; no changes were made.`,
      };
    }
  }
  if (document.version != null && document.version !== 1) {
    return {
      status: "manual",
      detail: `${path} uses unsupported Cursor hooks version ${String(document.version)}; no changes were made.`,
    };
  }
  let changed = document.version !== 1;
  document.version = 1;
  document.hooks ??= {};
  const ensure = (
    event: "beforeShellExecution" | "afterShellExecution" | "beforeMCPExecution",
    route: HookRoute,
    timeout: number,
  ) => {
    const entries = document.hooks![event] ?? [];
    const expected = hookCommand(route);
    const current = entries.find((entry) => entry.command === expected);
    if (current) {
      if (current.timeout !== timeout) {
        current.timeout = timeout;
        changed = true;
      }
      if (current.failClosed !== false) {
        current.failClosed = false;
        changed = true;
      }
      return;
    }
    const stale = entries.find((entry) => commandHasRoute(entry.command, route));
    if (stale) {
      stale.command = expected;
      stale.timeout = timeout;
      stale.failClosed = false;
    } else {
      entries.push({ command: expected, timeout, failClosed: false });
    }
    document.hooks![event] = entries;
    changed = true;
  };
  ensure("beforeShellExecution", "cursor", 120);
  ensure("afterShellExecution", "cursor-after", 30);
  ensure("beforeMCPExecution", "cursor-mcp", 120);
  if (!changed) return { status: "already", detail: path };
  backupOnce(path);
  writeFileSync(path, JSON.stringify(document, null, 2) + "\n");
  return { status: "installed", detail: path };
}
