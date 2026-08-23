import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isCursorHelperNode, resolveMonitorNodeBin, type InstallResult } from "../../../bridge/src/install";
import { configDir, normalizeRelayUrl } from "../../../bridge/src/config";
import { configuredCursorHttpMcpUrl } from "../cursor-config";
import { HTTP_SERVICE_LABEL, httpMcpLaunchAgentPath, packageRoot, xml } from "./common";
import { inspectHttpMcpService, restoreHttpMcpServiceAfterFailure, snapshotHttpMcpService } from "./snapshot";

/** Install/repair and load a per-user, loopback-only OAuth MCP daemon. */
export function installHttpMcpService(options: { forceReload?: boolean } = {}): InstallResult {
  if (process.platform !== "darwin") return macosOnly();
  const mcpUrl = configuredMcpUrl();
  if (mcpUrl instanceof Error) return { status: "manual", detail: mcpUrl.message };
  const nodeBin = safeNodeBin();
  if (nodeBin instanceof Error) return { status: "manual", detail: nodeBin.message };
  const executable = join(packageRoot, "bin", "granttap-mcp.mjs");
  const installation = validateInstallation(nodeBin, executable);
  if (installation) return installation;
  const path = httpMcpLaunchAgentPath();
  const logsDir = join(configDir(), "logs");
  const plist = createPlist(nodeBin, executable, mcpUrl, logsDir);
  if (plist instanceof Error) return { status: "manual", detail: plist.message };
  return installPlist(path, logsDir, plist, options);
}

function macosOnly(): InstallResult {
  return { status: "manual", detail: "persistent Cursor OAuth currently requires macOS" };
}

function configuredMcpUrl(): URL | Error {
  try {
    return new URL(configuredCursorHttpMcpUrl());
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function safeNodeBin(): string | Error {
  const nodeBin = resolveMonitorNodeBin();
  return nodeBin && !isCursorHelperNode(nodeBin)
    ? nodeBin
    : new Error("No safe absolute Node binary is available; refusing Cursor's short-lived helper node.");
}

function validateInstallation(nodeBin: string, executable: string): InstallResult | undefined {
  if (!existsSync(executable)) return { status: "manual", detail: `Installed launcher is missing at ${executable}` };
  if (packageRoot.includes("/.npm/_npx/")) {
    return { status: "manual", detail: "Authorize requires a stable granttap-mcp install; npm's temporary _npx cache is not durable." };
  }
  const version = spawnSync(nodeBin, ["--version"], { encoding: "utf8" });
  const major = Number(/^v(\d+)/.exec(version.stdout.trim())?.[1]);
  return version.status !== 0 || !Number.isInteger(major) || major < 20
    ? { status: "manual", detail: `Persistent OAuth requires Node 20+ (${nodeBin}).` }
    : undefined;
}

function createPlist(nodeBin: string, executable: string, mcpUrl: URL, logsDir: string): string | Error {
  const environment = serviceEnvironment(nodeBin, mcpUrl);
  if (environment instanceof Error) return environment;
  const logPath = join(logsDir, "http-mcp.log");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">', "<dict>", "  <key>Label</key>", `  <string>${HTTP_SERVICE_LABEL}</string>`,
    "  <key>ProgramArguments</key>", "  <array>", `    <string>${xml(nodeBin)}</string>`,
    `    <string>${xml(executable)}</string>`, "    <string>internal</string>",
    "    <string>serve</string>", "  </array>",
    "  <key>EnvironmentVariables</key>", "  <dict>",
    ...environment.flatMap(([key, value]) => [`    <key>${xml(key)}</key>`, `    <string>${xml(value)}</string>`]),
    "  </dict>", "  <key>WorkingDirectory</key>", `  <string>${xml(packageRoot)}</string>`,
    "  <key>RunAtLoad</key>", "  <true/>", "  <key>KeepAlive</key>", "  <true/>",
    "  <key>ProcessType</key>", "  <string>Background</string>", "  <key>ThrottleInterval</key>",
    "  <integer>30</integer>", "  <key>Umask</key>", "  <integer>63</integer>",
    "  <key>StandardOutPath</key>", `  <string>${xml(logPath)}</string>`, "  <key>StandardErrorPath</key>",
    `  <string>${xml(logPath)}</string>`, "</dict>", "</plist>", "",
  ].join("\n");
}

function serviceEnvironment(nodeBin: string, mcpUrl: URL): Array<[string, string]> | Error {
  const path = [dirname(nodeBin), join(homedir(), ".local", "bin"), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"].join(":");
  const values: Array<[string, string]> = [
    ["GRANTTAP_CONFIG_DIR", configDir()],
    ["GRANTTAP_MCP_HTTP_HOST", mcpUrl.hostname.replace(/^\[(.*)\]$/, "$1")],
    ["GRANTTAP_MCP_HTTP_PORT", mcpUrl.port],
    ["PATH", path],
  ];
  const rawRelayUrl = process.env.GRANTTAP_RELAY_URL ?? process.env.NODVOX_RELAY_URL;
  if (!rawRelayUrl) return values;
  try {
    values.push(["GRANTTAP_RELAY_URL", normalizeRelayUrl(rawRelayUrl)]);
    return values;
  } catch (error) {
    return new Error(`Refusing unsafe relay URL in persistent service: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function installPlist(path: string, logsDir: string, plist: string, options: { forceReload?: boolean }): InstallResult {
  const before = snapshotHttpMcpService();
  if (before.exists && !before.owned) return { status: "manual", detail: `${path} is not an owned GrantTap HTTP service; no changes were made.` };
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  const already = existsSync(path) && readFileSync(path, "utf8") === plist;
  if (already && !options.forceReload && inspectHttpMcpService().running) return { status: "already", detail: path };
  writePlist(path, plist);
  if (process.env.GRANTTAP_SKIP_LAUNCHCTL === "1") return { status: already ? "already" : "installed", detail: path };
  const uid = process.getuid?.();
  if (uid == null) return rollback(before, `${path}: could not determine user id`);
  const domain = `gui/${uid}`;
  spawnSync("launchctl", ["bootout", domain, path], { stdio: "ignore" });
  const loaded = spawnSync("launchctl", ["bootstrap", domain, path], { encoding: "utf8" });
  if (loaded.status !== 0) return rollback(before, `${path}: ${(loaded.stderr || loaded.stdout || "launchctl bootstrap failed").trim()}`);
  return { status: already ? "already" : "installed", detail: path };
}

function writePlist(path: string, plist: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, plist, { mode: 0o644 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function rollback(before: ReturnType<typeof snapshotHttpMcpService>, detail: string): InstallResult {
  restoreHttpMcpServiceAfterFailure(before);
  return { status: "manual", detail };
}
