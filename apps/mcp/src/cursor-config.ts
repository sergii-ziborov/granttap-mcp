import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CURSOR_HTTP_MCP_URL = "http://127.0.0.1:17342/mcp";

export function configuredCursorHttpMcpUrl(): string {
  const host = process.env.GRANTTAP_MCP_HTTP_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("Cursor OAuth MCP must use a loopback host");
  }
  const port = Number(process.env.GRANTTAP_MCP_HTTP_PORT ?? 17342);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Cursor OAuth MCP port must be between 1 and 65535");
  }
  return `http://${host === "::1" ? "[::1]" : host}:${port}/mcp`;
}

export type CursorConfigResult = {
  status: "installed" | "already" | "manual";
  detail: string;
};

export type CursorConfigStatus = {
  status: "connected" | "action_required" | "not_configured";
  detail: string;
};

export function cursorMcpConfigPath(): string {
  const cursorDir = process.env.GRANTTAP_CURSOR_DIR
    ?? process.env.NODVOX_CURSOR_DIR
    ?? join(homedir(), ".cursor");
  return process.env.GRANTTAP_CURSOR_MCP_CONFIG ?? join(cursorDir, "mcp.json");
}

function parseConfig(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isHttpEntry(value: unknown, expectedUrl: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return entry.url === expectedUrl
    && entry.command == null
    && entry.args == null
    && (entry.type == null || entry.type === "http");
}

export function isCursorHttpMcpConfigured(
  path = cursorMcpConfigPath(),
  expectedUrl = configuredCursorHttpMcpUrl(),
): boolean {
  const config = parseConfig(path);
  if (!config || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) {
    return false;
  }
  return isHttpEntry((config.mcpServers as Record<string, unknown>).granttap, expectedUrl);
}

export function validateCursorHttpConfig(
  path = cursorMcpConfigPath(),
): CursorConfigResult | null {
  const config = parseConfig(path);
  if (!config) {
    return { status: "manual", detail: `${path} is invalid JSON; no changes were made.` };
  }
  const rawServers = config.mcpServers;
  if (rawServers != null && (typeof rawServers !== "object" || Array.isArray(rawServers))) {
    return { status: "manual", detail: `${path} has a non-object mcpServers value; no changes were made.` };
  }
  return null;
}

export function inspectCursorHttpConfig(
  path = cursorMcpConfigPath(),
  expectedUrl = configuredCursorHttpMcpUrl(),
): CursorConfigStatus {
  if (!existsSync(path)) {
    return { status: "not_configured", detail: "Run granttap authorize to add Cursor." };
  }
  const config = parseConfig(path);
  if (!config) {
    return { status: "action_required", detail: "Cursor mcp.json is invalid JSON; fix it before Authorize." };
  }
  const servers = config.mcpServers;
  if (servers == null) {
    return { status: "not_configured", detail: "Run granttap authorize to add Cursor." };
  }
  if (typeof servers !== "object" || Array.isArray(servers)) {
    return { status: "action_required", detail: "Cursor mcpServers must be a JSON object." };
  }
  const entry = (servers as Record<string, unknown>).granttap;
  if (isHttpEntry(entry, expectedUrl)) {
    return { status: "action_required", detail: "Endpoint configured; keep local OAuth running and Authorize in Cursor." };
  }
  return entry == null
    ? { status: "not_configured", detail: "Run granttap authorize to add Cursor." }
    : { status: "action_required", detail: "Replace the existing GrantTap entry with the HTTP OAuth endpoint." };
}

/** Install only Cursor's GrantTap entry, preserving every unrelated MCP server. */
export function installCursorHttpConfig(
  path = cursorMcpConfigPath(),
  expectedUrl = configuredCursorHttpMcpUrl(),
): CursorConfigResult {
  const problem = validateCursorHttpConfig(path);
  if (problem) return problem;
  const config = parseConfig(path)!;
  const rawServers = config.mcpServers;
  const servers = (rawServers ?? {}) as Record<string, unknown>;
  if (isHttpEntry(servers.granttap, expectedUrl)) {
    return { status: "already", detail: `${path} → ${expectedUrl}` };
  }

  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && !existsSync(`${path}.bak-granttap`)) {
    copyFileSync(path, `${path}.bak-granttap`);
  }
  config.mcpServers = {
    ...servers,
    granttap: { url: expectedUrl },
  };
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return { status: "installed", detail: `${path} → ${expectedUrl}` };
}
