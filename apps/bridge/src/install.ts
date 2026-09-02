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
import { resolveCursorAgentBin } from "./reply/cursor-agent-bin";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { CodingAgent } from "../../../packages/protocol/schema";
import { refusesLiveLaunchd } from "./launchd-safety";
import { configDir, loadRuntimeConfig, verifiableEngine } from "./config";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export type HookRoute =
  | "claude"
  | "codex"
  | "codex-policy"
  | "cursor"
  | "cursor-after"
  | "cursor-mcp";

/** The stable command agents will call. */
export function hookCommand(agent: HookRoute): string {
  return `node "${join(repoRoot, "bin", "granttap-mcp.mjs")}" internal hook ${agent}`;
}

function commandHasRoute(command: unknown, route: HookRoute): boolean {
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
};

function executableAvailable(command: string): boolean {
  const candidates = command.includes("/")
    ? [command]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

const CLAUDE_MATCHERS = [
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

function codexHookSet(config: string): { permission: boolean; policy: boolean } {
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
  const claude = process.env.GRANTTAP_CLAUDE_BIN ?? process.env.NODVOX_CLAUDE_BIN ?? "claude";
  const cursor = process.env.GRANTTAP_CURSOR_AGENT_BIN ?? resolveCursorAgentBin();
  const grok = process.env.GRANTTAP_GROK_BIN ?? "grok";
  const cursorStatus = inspectCursorIntegration();
  return [
    { agent: "codex", installed: executableAvailable(codex), hookConfigured: codexHookConfigured() },
    { agent: "claude", installed: executableAvailable(claude), hookConfigured: claudeHookConfigured() },
    { agent: "cursor", installed: executableAvailable(cursor), hookConfigured: cursorStatus.hookConfigured },
    // Grok Build's headless session contract is direct; GrantTap does not
    // claim an approval hook exists when none has been installed.
    { agent: "grok", installed: executableAvailable(grok), hookConfigured: false },
  ];
}

// ------------------------------------------------------- background task sync

const launchAgentLabel = "com.granttap.monitor";

export type MonitorIntegrationStatus = {
  configured: boolean;
  running: boolean;
};

/** Read-only status check. It never installs, reloads, or repairs the helper. */
export function inspectMonitorHelper(): MonitorIntegrationStatus {
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
  const hasLabel = contents.includes(`<string>${launchAgentLabel}</string>`);
  const pinned = isNodvoxPinnedPlist(contents);
  const hasMonitorArgument = pinned
    ? /<string>monitor<\/string>/.test(contents)
    : /<string>internal<\/string>\s*<string>monitor<\/string>/.test(contents);
  const hasSafeExecutable = isNodvoxPinnedPlist(contents)
    || (contents.includes("granttap-mcp.mjs")
      && !contents.includes("Cursor.app")
      && !contents.includes("/helpers/node"));
  const configured = hasLabel && hasMonitorArgument && hasSafeExecutable;
  if (!configured) return { configured: false, running: false };
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

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function isCursorHelperNode(nodePath: string): boolean {
  return nodePath.includes("Cursor.app") || nodePath.includes("/helpers/node");
}

/** True when a plist uses the caller's explicit development monitor pin. */
export function isNodvoxPinnedPlist(contents: string): boolean {
  const pin = pinnedMonitorBin();
  if (!pin) return false;
  return (
    contents.includes(pin) &&
    !contents.includes("granttap-mcp.mjs") &&
    !contents.includes("Cursor.app") &&
    !contents.includes("/helpers/node")
  );
}

/** Absolute Node for LaunchAgent — never Cursor's helper node (wrong PATH / short-lived). */
export function resolveMonitorNodeBin(): string | null {
  const home = homedir();
  const pinned = join(home, ".nvm", "versions", "node", "v22.13.1", "bin", "node");
  const envNode = process.env.GRANTTAP_NODE?.trim();
  const nvmBin = process.env.NVM_BIN ? join(process.env.NVM_BIN, "node") : "";
  const which = spawnSync("which", ["node"], { encoding: "utf8" });
  const whichNode = (which.status === 0 ? which.stdout.trim() : "") || "";
  const candidates = [envNode, pinned, nvmBin, whichNode, process.execPath].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (isCursorHelperNode(candidate)) continue;
    return candidate;
  }
  return existsSync(pinned) ? pinned : null;
}

/**
 * Keep task/session sync alive without a terminal or a newly opened MCP chat.
 *
 * Hard rules:
 * - Never overwrite a healthy explicitly pinned LaunchAgent with package / Cursor helpers.
 * - Development pins are opt-in through `GRANTTAP_PINNED_MONITOR_BIN`.
 * - Never put Cursor.app helpers/node in ProgramArguments.
 */
/**
 * Carry a declared engine into the one process that publishes.
 *
 * The engine ships separately from this package, so its location is declared in
 * the runtime config rather than assumed. Without these four variables the
 * rollout flags stay off, `publishProjectPolicyStatuses` returns immediately,
 * and the phone shows "Governance not reported" forever with nothing in any log
 * to say why.
 */
function engineEnvironment(): string[] {
  const engine = verifiableEngine(loadRuntimeConfig());
  if (!engine) return [];
  return [
    "    <key>GRANTTAP_ENGINE_BINARY</key>",
    `    <string>${xml(engine.path)}</string>`,
    "    <key>GRANTTAP_ENGINE_SHA256</key>",
    `    <string>${engine.sha256}</string>`,
    "    <key>GRANTTAP_ENGINE_ENABLED</key>",
    '    <string>1</string>',
    "    <key>GRANTTAP_PROJECT_POLICY_ENABLED</key>",
    '    <string>1</string>',
  ];
}

export function installMonitorHelper(): InstallResult {
  if (process.platform !== "darwin") {
    return { status: "manual", detail: "background task sync currently requires macOS" };
  }

  const agentsDir =
    process.env.GRANTTAP_LAUNCH_AGENTS_DIR ?? join(homedir(), "Library", "LaunchAgents");
  const path = join(agentsDir, `${launchAgentLabel}.plist`);
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (isNodvoxPinnedPlist(existing)) {
      return { status: "already", detail: `${path} (preserved nodvox pin)` };
    }
  }

  const explicitPin = pinnedMonitorBin();
  const pinBin = explicitPin && existsSync(explicitPin) ? explicitPin : undefined;
  const usePin = pinBin != null;
  const executable = pinBin ?? join(repoRoot, "bin", "granttap-mcp.mjs");
  const workingDirectory = pinBin
    ? (pinnedMonitorRoot() ?? dirname(pinBin))
    : (process.env.GRANTTAP_MONITOR_CWD ?? process.cwd());
  const nodeBin = resolveMonitorNodeBin();
  if (!nodeBin) {
    return {
      status: "manual",
      detail:
        `${path}: no absolute Node (set GRANTTAP_NODE or use ~/.nvm/.../node) — refuse Cursor helpers`,
    };
  }
  if (isCursorHelperNode(nodeBin)) {
    return {
      status: "manual",
      detail: `${path}: refusing Cursor helpers node at ${nodeBin}`,
    };
  }

  const logPath = usePin
    ? join(homedir(), "Library", "Logs", "GrantTap", "monitor.err.log")
    : join(configDir(), "monitor.log");
  const environmentPath = usePin
    ? [
        join(homedir(), ".local", "bin"),
        dirname(nodeBin),
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/usr/bin",
        "/bin",
      ].join(":")
    : (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");

  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${launchAgentLabel}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${xml(nodeBin)}</string>`,
    `    <string>${xml(executable)}</string>`,
    ...(usePin ? [] : ["    <string>internal</string>"]),
    "    <string>monitor</string>",
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...(usePin
      ? [
          "    <key>GRANTTAP_LOCAL</key>",
          "    <string>1</string>",
        ]
      : []),
    "    <key>GRANTTAP_MONITOR_PRIMARY</key>",
    "    <string>1</string>",
    ...engineEnvironment(),
    "    <key>PATH</key>",
    `    <string>${xml(environmentPath)}</string>`,
    "  </dict>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xml(workingDirectory)}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>ThrottleInterval</key>",
    `  <integer>${usePin ? 10 : 5}</integer>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(logPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");

  mkdirSync(agentsDir, { recursive: true });
  if (!usePin) mkdirSync(configDir(), { recursive: true });
  else mkdirSync(dirname(logPath), { recursive: true });
  const already = existsSync(path) && readFileSync(path, "utf8") === plist;
  writeFileSync(path, plist, { mode: 0o644 });

  const detail = usePin ? `${path} → nodvox pin ${executable}` : path;
  if (process.env.GRANTTAP_SKIP_LAUNCHCTL === "1") {
    return { status: already ? "already" : "installed", detail };
  }

  const sandboxed = refusesLiveLaunchd(path);
  if (sandboxed) return { status: "manual", detail: sandboxed };
  const uid = process.getuid?.();
  if (uid == null) return { status: "manual", detail: `${path}: could not determine user id` };
  const domain = `gui/${uid}`;
  spawnSync("launchctl", ["bootout", domain, path], { stdio: "ignore" });
  const loaded = spawnSync("launchctl", ["bootstrap", domain, path], {
    encoding: "utf8",
  });
  if (loaded.status !== 0) {
    const err = (loaded.stderr || loaded.stdout || "launchctl bootstrap failed").trim();
    return { status: "manual", detail: `${path}: ${err}` };
  }
  return { status: already ? "already" : "installed", detail };
}

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
    if (!matcherChanged && !commandChanged) return { status: "already", detail: path };
    backupOnce(path);
    present.command = currentCommand;
    writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
    return { status: "installed", detail: `${path}, GrantTap hook and matcher repaired` };
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

function codexHooksExplicitlyDisabled(config: string): boolean {
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
