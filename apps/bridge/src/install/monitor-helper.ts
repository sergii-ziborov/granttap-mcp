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
  type InstallResult,
  launchAgentLabel,
  pinnedMonitorBin,
  pinnedMonitorRoot,
} from "./inspect";

export { isCursorHelperNode, resolveMonitorNodeBin };

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plistProgramUsesCursorHelper(contents: string): boolean {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(contents)?.[1] ?? "";
  return /Cursor\.app|[\\/]helpers[\\/]node/i.test(block);
}

function launchAgentPath(nodeBin: string): string {
  return [
    dirname(nodeBin),
    join(homedir(), ".local", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
  ].filter((dir, index, all) => dir && all.indexOf(dir) === index).join(":");
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

/** True when the plist is ours and, if it lives in the user Library, does not log to temp. */
export function monitorPlistLooksInstalled(contents: string, agentsDir: string): boolean {
  const hasLabel = contents.includes(`<string>${launchAgentLabel}</string>`);
  const pinned = isNodvoxPinnedPlist(contents);
  const hasMonitorArgument = pinned
    ? /<string>monitor<\/string>/.test(contents)
    : /<string>internal<\/string>\s*<string>monitor<\/string>/.test(contents);
  const hasSafeExecutable = pinned
    || (contents.includes("granttap-mcp.mjs") && !plistProgramUsesCursorHelper(contents));
  const liveHelper = !insideTemporaryDirectory(agentsDir);
  return hasLabel && hasMonitorArgument && hasSafeExecutable
    && !(liveHelper && plistUsesTemporaryIO(contents));
}

function monitorAgentsDir(): string {
  return process.env.GRANTTAP_LAUNCH_AGENTS_DIR
    ?? join(homedir(), "Library", "LaunchAgents");
}

function monitorPlistPath(): string {
  return join(monitorAgentsDir(), `${launchAgentLabel}.plist`);
}

export function monitorPlistNeedsRepair(path: string): boolean {
  if (!existsSync(path)) return true;
  try {
    return plistUsesTemporaryIO(readFileSync(path, "utf8"));
  } catch {
    return true;
  }
}

/** Pairing from a temp config must not touch the live helper. */
export function reloadPairingHelper(
  options: { firstPairing?: boolean; replace?: boolean } = {},
): InstallResult | undefined {
  if (insideTemporaryDirectory(configDir())) return undefined;
  const reloaded = reloadMonitorHelper();
  return options.firstPairing || options.replace ? installMonitorHelper() : reloaded;
}

/** Restart the already-installed monitor so it rereads the current pairing room. */
export function reloadMonitorHelper(): InstallResult {
  if (process.env.GRANTTAP_SKIP_LAUNCHCTL === "1" || process.env.NODE_TEST_CONTEXT) {
    return { status: "already", detail: "launchctl skipped" };
  }
  if (process.platform === "win32") return installMonitorHelper();
  if (process.platform !== "darwin") {
    return { status: "manual", detail: "background task sync currently requires macOS" };
  }
  if (monitorPlistNeedsRepair(monitorPlistPath())) return installMonitorHelper();
  const uid = process.getuid?.();
  if (uid == null) return { status: "manual", detail: "could not determine user id" };
  const kicked = spawnSync(
    "launchctl",
    ["kickstart", "-k", `gui/${uid}/${launchAgentLabel}`],
    { encoding: "utf8" },
  );
  if (kicked.status !== 0) return installMonitorHelper();
  return { status: "already", detail: `gui/${uid}/${launchAgentLabel}` };
}

function buildMonitorPlist(input: {
  nodeBin: string;
  executable: string;
  workingDirectory: string;
  logPath: string;
  usePin: boolean;
  environmentPath: string;
}): string {
  const { nodeBin, executable, workingDirectory, logPath, usePin, environmentPath } = input;
  return [
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
}

export function installMonitorHelper(): InstallResult {
  if (process.platform === "win32") {
    const node = resolveMonitorNodeBin();
    return node && !isCursorHelperNode(node)
      ? installWindowsTask("monitor", node, join(repoRoot, "bin", "granttap-mcp.mjs"))
      : { status: "manual", detail: "A stable Node.js 20+ installation is required for Windows background sync." };
  }
  if (process.platform !== "darwin") {
    return { status: "manual", detail: "background task sync currently requires macOS" };
  }

  const agentsDir = monitorAgentsDir();
  const path = monitorPlistPath();
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

  const liveAgents = !insideTemporaryDirectory(agentsDir);
  const durableLog = join(homedir(), "Library", "Logs", "GrantTap", "monitor.err.log");
  const logPath = usePin || liveAgents ? durableLog : join(configDir(), "monitor.log");
  const clobber = refusesClobberingLiveHelper({
    agentsDir,
    logPath,
    workingDirectory,
    configDirectory: configDir(),
  });
  if (clobber) return { status: "manual", detail: clobber };
  if (process.env.NODE_TEST_CONTEXT && liveAgents) {
    return { status: "manual", detail: CLOBBER_LIVE_HELPER_DETAIL };
  }
  const environmentPath = launchAgentPath(nodeBin);
  const plist = buildMonitorPlist({
    nodeBin, executable, workingDirectory, logPath, usePin, environmentPath,
  });

  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  if (!usePin && !liveAgents) mkdirSync(configDir(), { recursive: true });
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
