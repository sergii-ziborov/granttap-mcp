/** Persistent loopback HTTP MCP/OAuth service used by Cursor Authorize. */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isCursorHelperNode,
  resolveMonitorNodeBin,
  type InstallResult,
} from "../../bridge/src/install";
import { configDir, normalizeRelayUrl } from "../../bridge/src/config";
import { configuredCursorHttpMcpUrl } from "./cursor-config";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HTTP_SERVICE_LABEL = "com.granttap.mcp-http";

function isOwnedHttpService(contents: string): boolean {
  return contents.includes(`<string>${HTTP_SERVICE_LABEL}</string>`)
    && /granttap(?:-mcp)?(?:\.mjs)?<\/string>/.test(contents)
    && /<string>serve<\/string>/.test(contents);
}

function isConfiguredHttpService(contents: string): boolean {
  const expectedLauncher = join(packageRoot, "bin", "granttap-mcp.mjs");
  return contents.includes(`<string>${HTTP_SERVICE_LABEL}</string>`)
    && contents.includes(`<string>${xml(expectedLauncher)}</string>`)
    && /<string>serve<\/string>/.test(contents)
    && !contents.includes("Cursor.app")
    && !contents.includes("/helpers/node");
}

function isHttpMcpServiceLoaded(): boolean {
  if (process.platform !== "darwin" || process.env.GRANTTAP_SKIP_LAUNCHCTL === "1") {
    return false;
  }
  const uid = process.getuid?.();
  if (uid == null) return false;
  return spawnSync(
    "launchctl",
    ["print", `gui/${uid}/${HTTP_SERVICE_LABEL}`],
    { stdio: "ignore" },
  ).status === 0;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function httpMcpLaunchAgentPath(): string {
  const agentsDir = process.env.GRANTTAP_LAUNCH_AGENTS_DIR
    ?? join(homedir(), "Library", "LaunchAgents");
  return join(agentsDir, `${HTTP_SERVICE_LABEL}.plist`);
}

export type HttpMcpServiceStatus = {
  configured: boolean;
  running: boolean;
};

export type HttpMcpServiceSnapshot = {
  path: string;
  exists: boolean;
  plist: Buffer | null;
  mode: number;
  owned: boolean;
  configured: boolean;
  running: boolean;
};

/** Exact plist bytes/mode and loaded state for transactional repair rollback. */
export function snapshotHttpMcpService(): HttpMcpServiceSnapshot {
  const path = httpMcpLaunchAgentPath();
  if (!existsSync(path)) {
    return {
      path,
      exists: false,
      plist: null,
      mode: 0o644,
      owned: false,
      configured: false,
      running: false,
    };
  }
  let plist: Buffer;
  try {
    plist = readFileSync(path);
  } catch {
    return {
      path,
      exists: true,
      plist: null,
      mode: 0o644,
      owned: false,
      configured: false,
      running: false,
    };
  }
  const contents = plist.toString("utf8");
  const owned = isOwnedHttpService(contents);
  let mode = 0o644;
  try {
    mode = statSync(path).mode & 0o7777;
  } catch {
    // Content is still safe to restore with the LaunchAgent default mode.
  }
  return {
    path,
    exists: true,
    plist,
    mode,
    owned,
    configured: owned && isConfiguredHttpService(contents),
    running: owned && isHttpMcpServiceLoaded(),
  };
}

/** Read-only plist/process inspection. Health is probed separately. */
export function inspectHttpMcpService(): HttpMcpServiceStatus {
  if (process.platform !== "darwin") return { configured: false, running: false };
  const snapshot = snapshotHttpMcpService();
  return {
    configured: snapshot.configured,
    running: snapshot.configured && snapshot.running,
  };
}

/** Install/repair and load a per-user, loopback-only OAuth MCP daemon. */
export function installHttpMcpService(
  options: { forceReload?: boolean } = {},
): InstallResult {
  if (process.platform !== "darwin") {
    return { status: "manual", detail: "persistent Cursor OAuth currently requires macOS" };
  }
  let mcpUrl: URL;
  try {
    mcpUrl = new URL(configuredCursorHttpMcpUrl());
  } catch (error) {
    return {
      status: "manual",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const nodeBin = resolveMonitorNodeBin();
  if (!nodeBin || isCursorHelperNode(nodeBin)) {
    return {
      status: "manual",
      detail: "No safe absolute Node binary is available; refusing Cursor's short-lived helper node.",
    };
  }
  const executable = join(packageRoot, "bin", "granttap-mcp.mjs");
  if (!existsSync(executable)) {
    return { status: "manual", detail: `Installed launcher is missing at ${executable}` };
  }
  if (packageRoot.includes("/.npm/_npx/")) {
    return {
      status: "manual",
      detail: "Authorize requires a stable granttap-mcp install; npm's temporary _npx cache is not durable.",
    };
  }
  const nodeVersion = spawnSync(nodeBin, ["--version"], { encoding: "utf8" });
  const nodeMajor = Number(/^v(\d+)/.exec(nodeVersion.stdout.trim())?.[1]);
  if (nodeVersion.status !== 0 || !Number.isInteger(nodeMajor) || nodeMajor < 20) {
    return { status: "manual", detail: `Persistent OAuth requires Node 20+ (${nodeBin}).` };
  }

  const path = httpMcpLaunchAgentPath();
  const logsDir = join(configDir(), "logs");
  const logPath = join(logsDir, "http-mcp.log");
  const boundedPath = [
    dirname(nodeBin),
    join(homedir(), ".local", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
  ].join(":");
  const environment: Array<[string, string]> = [
    ["GRANTTAP_CONFIG_DIR", configDir()],
    ["GRANTTAP_MCP_HTTP_HOST", mcpUrl.hostname.replace(/^\[(.*)\]$/, "$1")],
    ["GRANTTAP_MCP_HTTP_PORT", mcpUrl.port],
    ["PATH", boundedPath],
  ];
  const rawRelayUrl = process.env.GRANTTAP_RELAY_URL ?? process.env.NODVOX_RELAY_URL;
  if (rawRelayUrl) {
    try {
      environment.push(["GRANTTAP_RELAY_URL", normalizeRelayUrl(rawRelayUrl)]);
    } catch (error) {
      return {
        status: "manual",
        detail: `Refusing unsafe relay URL in persistent service: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${HTTP_SERVICE_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${xml(nodeBin)}</string>`,
    `    <string>${xml(executable)}</string>`,
    "    <string>serve</string>",
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...environment.flatMap(([key, value]) => [
      `    <key>${xml(key)}</key>`,
      `    <string>${xml(value)}</string>`,
    ]),
    "  </dict>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xml(packageRoot)}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>ThrottleInterval</key>",
    "  <integer>30</integer>",
    "  <key>Umask</key>",
    "  <integer>63</integer>",
    "  <key>StandardOutPath</key>",
    `  <string>${xml(logPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(logPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");

  const before = snapshotHttpMcpService();
  if (before.exists && !before.owned) {
    return {
      status: "manual",
      detail: `${path} is not an owned GrantTap HTTP service; no changes were made.`,
    };
  }
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  const already = existsSync(path) && readFileSync(path, "utf8") === plist;
  if (already && !options.forceReload && inspectHttpMcpService().running) {
    return { status: "already", detail: path };
  }
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, plist, { mode: 0o644 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  if (process.env.GRANTTAP_SKIP_LAUNCHCTL === "1") {
    return { status: already ? "already" : "installed", detail: path };
  }

  const uid = process.getuid?.();
  if (uid == null) {
    restoreHttpMcpServiceAfterFailure(before);
    return { status: "manual", detail: `${path}: could not determine user id` };
  }
  const domain = `gui/${uid}`;
  spawnSync("launchctl", ["bootout", domain, path], { stdio: "ignore" });
  const loaded = spawnSync("launchctl", ["bootstrap", domain, path], { encoding: "utf8" });
  if (loaded.status !== 0) {
    const detail = (loaded.stderr || loaded.stdout || "launchctl bootstrap failed").trim();
    restoreHttpMcpServiceAfterFailure(before);
    return { status: "manual", detail: `${path}: ${detail}` };
  }
  return { status: already ? "already" : "installed", detail: path };
}

/** Bounded TCP preflight so an unknown listener is never put into a restart fight. */
export async function isHttpMcpPortOccupied(
  mcpUrl = configuredCursorHttpMcpUrl(),
  timeoutMs = 400,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (occupied: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    };
    const url = new URL(mcpUrl);
    const socket = new Socket();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(Number(url.port), url.hostname.replace(/^\[(.*)\]$/, "$1"));
  });
}

/** Restore a failed repair, deleting the service only when this attempt created it. */
export function restoreHttpMcpServiceAfterFailure(
  before: HttpMcpServiceSnapshot,
): boolean {
  if (before.exists && !before.owned) return false;
  let current: Buffer | null = null;
  if (existsSync(before.path)) {
    try {
      current = readFileSync(before.path);
    } catch {
      return false;
    }
    if (!isOwnedHttpService(current.toString("utf8"))) return false;
  }
  const currentlyLoaded = isHttpMcpServiceLoaded();
  if (current && before.plist?.equals(current) && before.running === currentlyLoaded) {
    return false;
  }

  if (process.env.GRANTTAP_SKIP_LAUNCHCTL !== "1") {
    const uid = process.getuid?.();
    if (uid != null) {
      spawnSync("launchctl", ["bootout", `gui/${uid}`, before.path], { stdio: "ignore" });
    }
  }
  if (!before.exists) {
    if (current) unlinkSync(before.path);
    return current != null;
  }
  if (!before.plist) return false;

  mkdirSync(dirname(before.path), { recursive: true });
  const temporary = `${before.path}.${process.pid}.restore.tmp`;
  try {
    writeFileSync(temporary, before.plist, { mode: before.mode });
    chmodSync(temporary, before.mode);
    renameSync(temporary, before.path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  if (before.running && process.env.GRANTTAP_SKIP_LAUNCHCTL !== "1") {
    const uid = process.getuid?.();
    if (uid == null) return false;
    const loaded = spawnSync(
      "launchctl",
      ["bootstrap", `gui/${uid}`, before.path],
      { stdio: "ignore" },
    );
    if (loaded.status !== 0) return false;
  }
  return true;
}

/** Verify the expected process, not merely an arbitrary listener on the port. */
export async function probeHttpMcpHealth(
  mcpUrl = configuredCursorHttpMcpUrl(),
  timeoutMs = 1_500,
): Promise<boolean> {
  try {
    const expected = new URL(mcpUrl).href;
    const response = await fetch(new URL("/healthz", expected), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = await response.json() as { ok?: unknown; service?: unknown; mcp?: unknown };
    return body.ok === true && body.service === "granttap-mcp" && body.mcp === expected;
  } catch {
    return false;
  }
}

export async function waitForHttpMcpHealth(
  mcpUrl = configuredCursorHttpMcpUrl(),
  timeoutMs = 8_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await probeHttpMcpHealth(mcpUrl, Math.min(1_000, timeoutMs))) return true;
    if (Date.now() >= deadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return false;
}
