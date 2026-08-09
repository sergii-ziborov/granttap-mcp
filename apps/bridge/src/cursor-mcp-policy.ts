import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_TOOL_INPUT_BYTES = 64 * 1024;
const MAX_SERVER_NAME = 160;

export type CursorMcpHookInput = {
  conversation_id?: unknown;
  session_id?: unknown;
  generation_id?: unknown;
  hook_event_name?: unknown;
  workspace_roots?: unknown;
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  command?: unknown;
  url?: unknown;
  mcp_server_name?: unknown;
  server_name?: unknown;
};

function boundedName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().replace(/^user-/, "");
  return value && value.length <= MAX_SERVER_NAME ? value : null;
}

function boundedString(raw: unknown, max = 4096): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value && value.length <= max ? value : null;
}

function parseToolInput(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_TOOL_INPUT_BYTES) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function configAt(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path) || statSync(path).size > MAX_CONFIG_BYTES) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const servers = parsed?.mcpServers;
    return servers && typeof servers === "object" && !Array.isArray(servers)
      ? servers as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function ancestors(rawRoot: string): string[] {
  const result: string[] = [];
  let current = resolve(rawRoot);
  for (let depth = 0; depth < 24; depth += 1) {
    result.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}

function configuredServers(
  input: CursorMcpHookInput,
  cursorDir: string,
): Map<string, Record<string, unknown>> {
  const sources = [configAt(join(cursorDir, "mcp.json"))];
  const roots = Array.isArray(input.workspace_roots)
    ? input.workspace_roots.filter((root): root is string => typeof root === "string").slice(0, 16)
    : [];
  const cwd = boundedString(input.cwd, 4096);
  if (cwd) roots.push(cwd);
  const seen = new Set<string>();
  for (const root of roots) {
    for (const dir of ancestors(root)) {
      for (const path of [join(dir, ".cursor", "mcp.json"), join(dir, ".mcp.json")]) {
        if (seen.has(path)) continue;
        seen.add(path);
        sources.push(configAt(path));
      }
    }
  }
  const servers = new Map<string, Record<string, unknown>>();
  for (const source of sources) {
    for (const [rawName, descriptor] of Object.entries(source)) {
      const name = boundedName(rawName);
      if (!name || !descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) continue;
      servers.set(name, descriptor as Record<string, unknown>);
    }
  }
  return servers;
}

function exactDescriptorCommand(descriptor: Record<string, unknown>): string[] {
  const command = boundedString(descriptor.command);
  if (!command) return [];
  const values = [command];
  if (Array.isArray(descriptor.args)) {
    const args = descriptor.args
      .filter((arg): arg is string => typeof arg === "string")
      .slice(0, 64);
    if (args.length === descriptor.args.length) values.push([command, ...args].join(" "));
  }
  return values;
}

/** Resolve one exact configured MCP server. Ambiguous matches abstain. */
export function resolveCursorMcpServer(
  input: CursorMcpHookInput,
  cursorDir = process.env.GRANTTAP_CURSOR_DIR ?? join(homedir(), ".cursor"),
): string | null {
  const servers = configuredServers(input, cursorDir);
  const explicit = new Set<string>();
  for (const raw of [input.mcp_server_name, input.server_name]) {
    const name = boundedName(raw);
    if (name) explicit.add(name);
  }
  const toolInput = parseToolInput(input.tool_input);
  for (const raw of [toolInput?.server, toolInput?.serverName, toolInput?.mcpServer]) {
    const name = boundedName(raw);
    if (name) explicit.add(name);
  }
  const encoded = typeof input.tool_name === "string"
    ? /^mcp__(.+?)__(.+)$/i.exec(input.tool_name.trim())?.[1]
    : undefined;
  const encodedName = boundedName(encoded);
  if (encodedName) explicit.add(encodedName);

  const command = boundedString(input.command);
  const url = boundedString(input.url);
  const matches = new Set<string>();
  for (const name of explicit) {
    if (servers.size === 0 || servers.has(name)) matches.add(name);
  }
  for (const [name, descriptor] of servers) {
    if (command === name || command === `user-${name}`) matches.add(name);
    if (url && boundedString(descriptor.url) === url) matches.add(name);
    if (command && exactDescriptorCommand(descriptor).includes(command)) matches.add(name);
  }
  return matches.size === 1 ? ([...matches][0] ?? null) : null;
}

export function cursorConversationId(input: CursorMcpHookInput): string | null {
  const value = input.conversation_id ?? input.session_id;
  return typeof value === "string" && value.trim() && value.trim().length <= 256
    ? value.trim()
    : null;
}
