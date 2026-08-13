import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SessionInfo } from "../../../../packages/protocol/schema";
import type { CodexMcpRow, McpDescriptor, McpTransportConfig } from "./types";

let codexCache: { at: number; rows: CodexMcpRow[] } | undefined;
const CACHE_MS = 30_000;

export function descriptorsForSession(session: SessionInfo): McpDescriptor[] {
  if (session.agent === "codex") return codexMcpDescriptors();
  return claudeMcpDescriptors(session.cwd);
}

export function ancestors(cwd: string): string[] {
  const out: string[] = [];
  let current = resolve(cwd);
  for (;;) {
    out.push(current);
    if (existsSync(join(current, ".git"))) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

function codexMcpDescriptors(): McpDescriptor[] {
  return codexMcpRows()
    .filter((row) => typeof row.name === "string")
    .map((row) => ({
      name: String(row.name),
      configuredEnabled: row.enabled !== false,
      authStatus: typeof row.auth_status === "string" ? row.auth_status : undefined,
      transport: row.transport && typeof row.transport === "object"
        ? row.transport as McpTransportConfig
        : undefined,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function codexMcpRows(): CodexMcpRow[] {
  if (codexCache && Date.now() - codexCache.at < CACHE_MS) return codexCache.rows;
  try {
    const command = process.env.GRANTTAP_CODEX_BIN ?? process.env.NODVOX_CODEX_BIN ?? "codex";
    const output = execFileSync(command, ["mcp", "list", "--json"], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(output);
    const rows = Array.isArray(parsed) ? parsed as CodexMcpRow[] : [];
    codexCache = { at: Date.now(), rows };
    return rows;
  } catch {
    return codexCache?.rows ?? [];
  }
}

function claudeMcpDescriptors(cwd: string | undefined): McpDescriptor[] {
  const config = jsonFile(join(homedir(), ".claude.json"));
  const configs = new Map<string, McpTransportConfig>();
  appendConfiguredServers(config.mcpServers, configs);
  if (cwd) {
    for (const dir of ancestors(cwd)) {
      appendConfiguredServers(jsonFile(join(dir, ".mcp.json")).mcpServers, configs);
    }
  }
  return [...configs.entries()]
    .map(([name, transport]) => ({ name, configuredEnabled: true, transport }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function appendConfiguredServers(value: unknown, configs: Map<string, McpTransportConfig>): void {
  if (!value || typeof value !== "object") return;
  for (const [name, transport] of Object.entries(value)) {
    if (transport && typeof transport === "object") {
      configs.set(name, transport as McpTransportConfig);
    }
  }
}

function jsonFile(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
