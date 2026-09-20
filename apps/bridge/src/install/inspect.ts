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
import { monitorPlistLooksInstalled } from "./monitor-helper";
import { codexHooksExplicitlyDisabled } from "./hooks";

export { isCursorHelperNode, resolveMonitorNodeBin };

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

export type HookRoute =
  | "claude"
  | "claude-prompt"
  | "codex"
  | "codex-policy"
  | "cursor"
  | "cursor-after"
  | "cursor-mcp";

/** The stable command agents will call. */
export function hookCommand(agent: HookRoute): string {
  return `node "${join(repoRoot, "bin", "granttap-mcp.mjs")}" internal hook ${agent}`;
}

export function commandHasRoute(command: unknown, route: HookRoute): boolean {
  if (typeof command !== "string" || !/(?:granttap|nodvox)/i.test(command)) return false;
  const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\bhook\\s+${escaped}(?:\\s|[\"']|$)`).test(command);
}

function commandIsCurrentRoute(command: unknown, route: HookRoute): boolean {
  return typeof command === "string" && command.trim() === hookCommand(route);
}

export type InstallResult = { status: "installed" | "already" | "manual"; detail: string };
export const CODEX_TRUST_INSTRUCTION =
  "Open /hooks in Codex, review and trust both GrantTap hooks, then restart Codex.";

export type AgentIntegrationStatus = {
  agent: CodingAgent;
  installed: boolean;
  hookConfigured: boolean;
  version?: string;
  updateCommand?: string;
  newerOnThisMac?: string;
  updating?: boolean;
};

function executableAvailable(command: string): boolean {
  const slashed = /[\\/]/.test(command);
  const names = slashed || process.platform !== "win32"
    ? [command]
    : [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`];
  const candidates = slashed
    ? names
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean)
      .flatMap((dir) => names.map((name) => join(dir, name)));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export const CLAUDE_MATCHERS = [
  "Bash",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Skill",
  "mcp__.*",
  "skill__.*",
];

function claudeMatcherCoversPolicy(matcher: unknown): boolean {
  if (typeof matcher !== "string") return false;
  const tokens = new Set(matcher.split("|").map((token) => token.trim()).filter(Boolean));
  return matcher.trim() === ".*"
    || CLAUDE_MATCHERS.every((token) => tokens.has(token));
}

function claudeHookConfigured(): boolean {
  const dir = process.env.GRANTTAP_CLAUDE_DIR
    ?? process.env.NODVOX_CLAUDE_DIR
    ?? join(homedir(), ".claude");
  const path = join(dir, "settings.json");
  if (!existsSync(path)) return false;
  try {
    const settings = JSON.parse(readFileSync(path, "utf8")) as {
      hooks?: {
        PreToolUse?: Array<{ matcher?: unknown; hooks?: Array<{ command?: unknown }> }>;
      };
    };
    return (settings.hooks?.PreToolUse ?? []).some((entry) =>
      claudeMatcherCoversPolicy(entry.matcher)
      && (entry.hooks ?? []).some((hook) =>
        (hook as { type?: unknown }).type === "command"
          && commandIsCurrentRoute(hook.command, "claude"),
      ),
    );
  } catch {
    return false;
  }
}

export function codexHookSet(config: string): { permission: boolean; policy: boolean } {
  type Event = "PermissionRequest" | "PreToolUse";
  let event: Event | null = null;
  let matcherAll = false;
  let inCommandHook = false;
  let commandType = false;
  let command: string | null = null;
  let timeout: number | null = null;
  let permission = false;
  let policy = false;
  const finishCommandHook = () => {
    if (!event || !matcherAll || !inCommandHook || !commandType) return;
    if (event === "PermissionRequest"
      && timeout === 120
      && commandIsCurrentRoute(command, "codex")) {
      permission = true;
    }
    if (event === "PreToolUse"
      && timeout === 30
      && commandIsCurrentRoute(command, "codex-policy")) {
      policy = true;
    }
  };
  for (const line of config.split(/\r?\n/)) {
    const parent = line.match(/^\s*\[\[hooks\.(PermissionRequest|PreToolUse)\]\]\s*(?:#.*)?$/i);
    if (parent) {
      finishCommandHook();
      event = parent[1]!.toLowerCase() === "permissionrequest"
        ? "PermissionRequest"
        : "PreToolUse";
      matcherAll = false;
      inCommandHook = false;
      commandType = false;
      command = null;
      timeout = null;
      continue;
    }
    const child = line.match(
      /^\s*\[\[hooks\.(PermissionRequest|PreToolUse)\.hooks\]\]\s*(?:#.*)?$/i,
    );
    if (child) {
      finishCommandHook();
      const childEvent: Event = child[1]!.toLowerCase() === "permissionrequest"
        ? "PermissionRequest"
        : "PreToolUse";
      inCommandHook = event === childEvent;
      commandType = false;
      command = null;
      timeout = null;
      continue;
    }
    if (/^\s*\[/.test(line)) {
      finishCommandHook();
      event = null;
      matcherAll = false;
      inCommandHook = false;
      commandType = false;
      command = null;
      timeout = null;
      continue;
    }
    if (event && !inCommandHook) {
      const matcher = line.match(/^\s*matcher\s*=\s*["'](.*)["']\s*(?:#.*)?$/i)?.[1];
      if (matcher != null) matcherAll = matcher.trim() === ".*";
    } else if (inCommandHook) {
      const type = line.match(/^\s*type\s*=\s*["'](.*)["']\s*(?:#.*)?$/i)?.[1];
      if (type != null) commandType = type.trim().toLowerCase() === "command";
      const value = line.match(/^\s*command\s*=\s*["'](.*)["']\s*(?:#.*)?$/i)?.[1];
      if (value != null) command = value;
      const rawTimeout = line.match(/^\s*timeout\s*=\s*(\d+)\s*(?:#.*)?$/i)?.[1];
      if (rawTimeout != null) timeout = Number(rawTimeout);
    }
  }
  finishCommandHook();
  return { permission, policy };
}

function codexHookConfigured(): boolean {
  const dir = process.env.GRANTTAP_CODEX_DIR
    ?? process.env.NODVOX_CODEX_DIR
    ?? join(homedir(), ".codex");
  const path = join(dir, "config.toml");
  if (!existsSync(path)) return false;
  const config = readFileSync(path, "utf8");
  const hooks = codexHookSet(config);
  return !codexHooksExplicitlyDisabled(config) && hooks.permission && hooks.policy;
}

export type CursorIntegrationStatus = {
  installed: boolean;
  hookConfigured: boolean;
};

export function inspectCursorIntegration(): CursorIntegrationStatus {
  const dir = process.env.GRANTTAP_CURSOR_DIR
    ?? process.env.NODVOX_CURSOR_DIR
    ?? join(homedir(), ".cursor");
  const path = join(dir, "hooks.json");
  if (!existsSync(path)) return { installed: existsSync(dir), hookConfigured: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      version?: unknown;
      hooks?: Record<string, Array<{ command?: unknown; failClosed?: unknown }>>;
    };
    const has = (event: string, route: HookRoute, timeout: number): boolean =>
      Array.isArray(parsed.hooks?.[event])
      && parsed.hooks![event]!.some((entry) =>
        commandIsCurrentRoute(entry.command, route)
          && entry.failClosed === false
          && (entry as { timeout?: unknown }).timeout === timeout,
      );
    return {
      installed: true,
      hookConfigured: parsed.version === 1
        && has("beforeShellExecution", "cursor", 120)
        && has("afterShellExecution", "cursor-after", 30)
        && has("beforeMCPExecution", "cursor-mcp", 120),
    };
  } catch {
    return { installed: true, hookConfigured: false };
  }
}

/** Read-only capability check used by phone/watch connection states. */
export function inspectAgentIntegrations(): AgentIntegrationStatus[] {
  const codex = process.env.GRANTTAP_CODEX_BIN ?? process.env.NODVOX_CODEX_BIN ?? "codex";
  const claude = resolveClaudeBinary().path;
  const cursor = process.env.GRANTTAP_CURSOR_AGENT_BIN ?? resolveCursorAgentBin();
  const grok = process.env.GRANTTAP_GROK_BIN ?? "grok";
  const cursorStatus = inspectCursorIntegration();
  const tools = new Map(inspectTools().map((tool) => [tool.agent, tool]));
  const updating = new Set(updatingTools());
  const tool = (agent: CodingAgent): Partial<AgentIntegrationStatus> => {
    const status = tools.get(agent);
    const extra: Partial<AgentIntegrationStatus> = {};
    if (status?.version) extra.version = status.version;
    if (status?.update) extra.updateCommand = describeCommand(status.update);
    if (status?.newerOnThisMac) extra.newerOnThisMac = status.newerOnThisMac;
    if (updating.has(agent)) extra.updating = true;
    return extra;
  };
  return [
    { agent: "codex", installed: executableAvailable(codex), hookConfigured: codexHookConfigured(), ...tool("codex") },
    { agent: "claude", installed: executableAvailable(claude), hookConfigured: claudeHookConfigured(), ...tool("claude") },
    { agent: "cursor", installed: executableAvailable(cursor), hookConfigured: cursorStatus.hookConfigured, ...tool("cursor") },
    // Grok Build's headless session contract is direct; GrantTap does not
    // claim an approval hook exists when none has been installed.
    { agent: "grok", installed: executableAvailable(grok), hookConfigured: false, ...tool("grok") },
  ];
}

// ------------------------------------------------------- background task sync

export const launchAgentLabel = "com.granttap.monitor";

export type MonitorIntegrationStatus = {
  configured: boolean;
  running: boolean;
};

/** Read-only status check. It never installs, reloads, or repairs the helper. */
export function inspectMonitorHelper(): MonitorIntegrationStatus {
  if (process.platform === "win32") return inspectWindowsTask("monitor");
  if (process.platform !== "darwin") return { configured: false, running: false };
  const agentsDir = process.env.GRANTTAP_LAUNCH_AGENTS_DIR
    ?? join(homedir(), "Library", "LaunchAgents");
  const path = join(agentsDir, `${launchAgentLabel}.plist`);
  if (!existsSync(path)) return { configured: false, running: false };
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return { configured: false, running: false };
  }
  if (!monitorPlistLooksInstalled(contents, agentsDir)) return { configured: false, running: false };
  const uid = process.getuid?.();
  if (uid == null) return { configured: true, running: false };
  const active = spawnSync(
    "launchctl",
    ["print", `gui/${uid}/${launchAgentLabel}`],
    { stdio: "ignore" },
  );
  return { configured: true, running: active.status === 0 };
}

/** Optional explicit development pin; public installs use this package by default. */
export function pinnedMonitorBin(): string | undefined {
  const override = process.env.GRANTTAP_PINNED_MONITOR_BIN?.trim();
  return override && override.length > 0 ? override : undefined;
}

export function pinnedMonitorRoot(): string | undefined {
  const override = process.env.GRANTTAP_PINNED_MONITOR_ROOT?.trim();
  return override && override.length > 0 ? override : undefined;
}
