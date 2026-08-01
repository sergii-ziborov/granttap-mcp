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
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { configDir } from "./config";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The stable command agents will call. */
export function hookCommand(agent: "claude" | "codex"): string {
  return `node "${join(repoRoot, "bin", "granttap-mcp.mjs")}" hook ${agent}`;
}

export type InstallResult = { status: "installed" | "already" | "manual"; detail: string };

export type AgentIntegrationStatus = {
  agent: "codex" | "claude";
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

function claudeHookConfigured(): boolean {
  const dir = process.env.GRANTTAP_CLAUDE_DIR
    ?? process.env.NODVOX_CLAUDE_DIR
    ?? join(homedir(), ".claude");
  const path = join(dir, "settings.json");
  if (!existsSync(path)) return false;
  try {
    const settings = JSON.parse(readFileSync(path, "utf8")) as {
      hooks?: { PreToolUse?: Array<{ hooks?: Array<{ command?: unknown }> }> };
    };
    return (settings.hooks?.PreToolUse ?? []).some((entry) =>
      (entry.hooks ?? []).some((hook) =>
        typeof hook.command === "string" && hook.command.includes("granttap"),
      ),
    );
  } catch {
    return false;
  }
}

function codexHookConfigured(): boolean {
  const dir = process.env.GRANTTAP_CODEX_DIR
    ?? process.env.NODVOX_CODEX_DIR
    ?? join(homedir(), ".codex");
  const path = join(dir, "config.toml");
  if (!existsSync(path)) return false;
  const config = readFileSync(path, "utf8");
  return /^command\s*=\s*(?:'[^'\n]*granttap[^'\n]*'|"[^"\n]*granttap[^"\n]*")\s*$/m.test(config);
}

/** Read-only capability check used by phone/watch connection states. */
export function inspectAgentIntegrations(): AgentIntegrationStatus[] {
  const codex = process.env.GRANTTAP_CODEX_BIN ?? process.env.NODVOX_CODEX_BIN ?? "codex";
  const claude = process.env.GRANTTAP_CLAUDE_BIN ?? process.env.NODVOX_CLAUDE_BIN ?? "claude";
  return [
    { agent: "codex", installed: executableAvailable(codex), hookConfigured: codexHookConfigured() },
    { agent: "claude", installed: executableAvailable(claude), hookConfigured: claudeHookConfigured() },
  ];
}

// ------------------------------------------------------- background task sync

const launchAgentLabel = "com.granttap.monitor";

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Keep task/session sync alive without a terminal or a newly opened MCP chat.
 * The MCP process and this helper share a leader lock, so phone messages are
 * handled exactly once even when several agent chats are open.
 */
export function installMonitorHelper(): InstallResult {
  if (process.platform !== "darwin") {
    return { status: "manual", detail: "background task sync currently requires macOS" };
  }

  const agentsDir =
    process.env.GRANTTAP_LAUNCH_AGENTS_DIR ?? join(homedir(), "Library", "LaunchAgents");
  const path = join(agentsDir, `${launchAgentLabel}.plist`);
  const logPath = join(configDir(), "monitor.log");
  const executable = join(repoRoot, "bin", "granttap-mcp.mjs");
  const workingDirectory = process.env.GRANTTAP_MONITOR_CWD ?? process.cwd();
  const environmentPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${launchAgentLabel}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${xml(process.execPath)}</string>`,
    `    <string>${xml(executable)}</string>`,
    "    <string>monitor</string>",
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
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
    "  <integer>5</integer>",
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(logPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");

  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(configDir(), { recursive: true });
  const already = existsSync(path) && readFileSync(path, "utf8") === plist;
  writeFileSync(path, plist, { mode: 0o644 });

  if (process.env.GRANTTAP_SKIP_LAUNCHCTL === "1") {
    return { status: already ? "already" : "installed", detail: path };
  }

  const uid = process.getuid?.();
  if (uid == null) return { status: "manual", detail: `${path}: could not determine user id` };
  const domain = `gui/${uid}`;
  spawnSync("launchctl", ["bootout", domain, path], { stdio: "ignore" });
  const loaded = spawnSync("launchctl", ["bootstrap", domain, path], {
    encoding: "utf8",
  });
  if (loaded.status !== 0) {
    const detail = (loaded.stderr || loaded.stdout || "launchctl bootstrap failed").trim();
    return { status: "manual", detail: `${path}: ${detail}` };
  }
  return { status: already ? "already" : "installed", detail: path };
}

function backupOnce(path: string): void {
  const bak = path + ".bak-granttap";
  if (existsSync(path) && !existsSync(bak)) copyFileSync(path, bak);
}

// ---------------------------------------------------------------- Claude Code

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
  const hooks = entries.flatMap((entry) => entry?.hooks ?? []);
  const currentCommand = hookCommand("claude");
  const present = hooks.find(
    (hook: any) => typeof hook?.command === "string" && hook.command.includes("granttap"),
  );
  if (present) {
    if (present.command === currentCommand) return { status: "already", detail: path };
    backupOnce(path);
    present.command = currentCommand;
    writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
    return { status: "installed", detail: `${path}, GrantTap hook updated` };
  }

  const legacy = hooks.find(
    (hook: any) =>
      typeof hook?.command === "string" &&
      (hook.command.includes("bin/nodvox.mjs") || /\bnpx\s+(?:-y\s+)?nodvox\b/.test(hook.command)),
  );
  if (legacy) {
    backupOnce(path);
    legacy.command = hookCommand("claude");
    writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
    return { status: "installed", detail: `${path}, обновлён Nodvox → GrantTap` };
  }

  backupOnce(path);
  entries.push({
    matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__.*",
    hooks: [{ type: "command", command: hookCommand("claude"), timeout: 120 }],
  });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  return { status: "installed", detail: path };
}

// --------------------------------------------------------------------- Codex

export function installCodexHook(): InstallResult {
  const dir =
    process.env.GRANTTAP_CODEX_DIR ??
    process.env.NODVOX_CODEX_DIR ??
    join(homedir(), ".codex");
  const path = join(dir, "config.toml");
  mkdirSync(dir, { recursive: true });

  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (existing.includes("bin/nodvox.mjs") || /\bnpx\s+(?:-y\s+)?nodvox\b/.test(existing)) {
    const updated = existing
      .replace(
        /^command\s*=\s*'[^']*(?:bin\/nodvox\.mjs|\bnpx\s+(?:-y\s+)?nodvox\b)[^']*'$/gm,
        `command = '${hookCommand("codex")}'`,
      )
      .replace(/^# nodvox —/gm, "# GrantTap —");
    backupOnce(path);
    writeFileSync(path, updated);
    return { status: "installed", detail: `${path}, обновлён Nodvox → GrantTap` };
  }
  const currentCommand = hookCommand("codex");
  const granttapHook = existing.match(/^command\s*=\s*'([^'\n]*granttap[^'\n]*)'$/m)
    ?? existing.match(/^command\s*=\s*"([^"\n]*granttap[^"\n]*)"$/m);
  if (granttapHook) {
    if (granttapHook[1] === currentCommand) return { status: "already", detail: path };
    backupOnce(path);
    writeFileSync(path, existing.replace(granttapHook[0], `command = '${currentCommand}'`));
    return { status: "installed", detail: `${path}, GrantTap hook updated` };
  }

  const hookBlock = [
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

  const hasFeatures = /^\s*\[features\]/m.test(existing);
  const hasHooksFlag = /^\s*hooks\s*=\s*true/m.test(existing);

  backupOnce(path);
  if (!hasFeatures) {
    writeFileSync(path, existing + "\n[features]\nhooks = true\n" + hookBlock);
    return { status: "installed", detail: path };
  }
  if (hasHooksFlag) {
    writeFileSync(path, existing + hookBlock);
    return { status: "installed", detail: path };
  }
  // [features] exists without hooks=true — appending a second [features] table
  // would be invalid TOML, so append the hook and ask for the one-line edit.
  writeFileSync(path, existing + hookBlock);
  return {
    status: "manual",
    detail: `${path}: hook добавлен, но в существующей секции [features] нужно вручную дописать «hooks = true».`,
  };
}
