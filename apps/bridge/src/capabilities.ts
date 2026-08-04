import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Implementation } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerInfo, SessionInfo, SkillInfo } from "../../../packages/protocol/schema";

type CodexMcpRow = {
  name?: unknown;
  enabled?: unknown;
  auth_status?: unknown;
  transport?: unknown;
};

type McpTransportConfig = {
  type?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  env_vars?: unknown;
  cwd?: unknown;
  url?: unknown;
  bearer_token_env_var?: unknown;
  http_headers?: unknown;
  env_http_headers?: unknown;
  headers?: unknown;
};

type McpDescriptor = {
  name: string;
  configuredEnabled: boolean;
  authStatus?: string;
  transport?: McpTransportConfig;
};

type ServerMetadata = Pick<
  McpServerInfo,
  "title" | "websiteUrl" | "version" | "icons" | "metadataSource"
>;

let codexCache: { at: number; rows: CodexMcpRow[] } | undefined;
const CACHE_MS = 30_000;

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
    const rows = Array.isArray(parsed) ? parsed : [];
    codexCache = { at: Date.now(), rows };
    return rows;
  } catch {
    return codexCache?.rows ?? [];
  }
}

function jsonFile(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function ancestors(cwd: string): string[] {
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

function claudeMcpDescriptors(cwd: string | undefined): McpDescriptor[] {
  const config = jsonFile(join(homedir(), ".claude.json"));
  const configs = new Map<string, McpTransportConfig>();
  for (const [name, value] of Object.entries(config.mcpServers ?? {})) {
    if (value && typeof value === "object") configs.set(name, value as McpTransportConfig);
  }
  if (cwd) {
    for (const dir of ancestors(cwd)) {
      const project = jsonFile(join(dir, ".mcp.json"));
      for (const [name, value] of Object.entries(project.mcpServers ?? {})) {
        if (value && typeof value === "object") configs.set(name, value as McpTransportConfig);
      }
    }
  }
  return [...configs.entries()]
    .map(([name, transport]) => ({ name, configuredEnabled: true, transport }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function descriptorsForSession(session: SessionInfo): McpDescriptor[] {
  if (session.agent === "codex") {
    return codexMcpRows()
      .filter((row) => typeof row.name === "string")
      .map((row) => {
        const name = String(row.name);
        const configuredEnabled = row.enabled !== false;
        return {
          name,
          configuredEnabled,
          authStatus: typeof row.auth_status === "string" ? row.auth_status : undefined,
          transport: row.transport && typeof row.transport === "object"
            ? row.transport as McpTransportConfig
            : undefined,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return claudeMcpDescriptors(session.cwd);
}

const metadataCache = new Map<string, { at: number; value?: ServerMetadata }>();
const metadataPending = new Map<string, Promise<void>>();
const METADATA_SUCCESS_TTL_MS = 6 * 60 * 60_000;
const METADATA_FAILURE_TTL_MS = 10 * 60_000;

function descriptorKey(descriptor: McpDescriptor): string {
  const transport = descriptor.transport;
  return JSON.stringify([
    descriptor.name,
    transport?.type,
    transport?.url,
    transport?.command,
    transport?.args,
    transport?.cwd,
  ]);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] =>
    typeof entry[1] === "string"));
}

const MAX_MCP_ICON_BYTES = 16 * 1024;

function imageMime(bytes: Buffer): "image/png" | "image/jpeg" | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return undefined;
}

async function safeIconData(src: string, remoteUrl?: URL): Promise<{
  src: string;
  mimeType: "image/png" | "image/jpeg";
} | undefined> {
  const dataMatch = src.match(/^data:image\/(png|jpe?g);base64,([a-z0-9+/=\s]+)$/i);
  if (dataMatch) {
    const encoded = dataMatch[2]!.replace(/\s/g, "");
    if (encoded.length > Math.ceil(MAX_MCP_ICON_BYTES * 4 / 3) + 4) return undefined;
    const bytes = Buffer.from(encoded, "base64");
    const mimeType = imageMime(bytes);
    if (!mimeType || bytes.length > MAX_MCP_ICON_BYTES) return undefined;
    return { src: `data:${mimeType};base64,${bytes.toString("base64")}`, mimeType };
  }

  const initial = safeHttpsUrl(src);
  if (!initial || (remoteUrl && initial.origin !== remoteUrl.origin)) return undefined;
  let current: URL = initial;
  const allowedOrigin = initial.origin;
  try {
    for (let redirect = 0; redirect <= 2; redirect += 1) {
      const response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        headers: { Accept: "image/png, image/jpeg" },
        signal: AbortSignal.timeout(5_000),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        const target: URL | undefined = location
          ? safeHttpsUrl(new URL(location, current).toString())
          : undefined;
        if (!target || target.origin !== allowedOrigin) return undefined;
        current = target;
        continue;
      }
      if (!response.ok) return undefined;
      const length = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(length) && length > MAX_MCP_ICON_BYTES) return undefined;
      const bytes = await readResponseBodyLimited(response, MAX_MCP_ICON_BYTES);
      if (!bytes) return undefined;
      const mimeType = imageMime(bytes);
      if (!mimeType || bytes.length > MAX_MCP_ICON_BYTES) return undefined;
      return { src: `data:${mimeType};base64,${bytes.toString("base64")}`, mimeType };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function readResponseBodyLimited(response: Response, maxBytes: number): Promise<Buffer | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function normalizedIcons(
  info: Implementation,
  descriptor: McpDescriptor,
): Promise<NonNullable<McpServerInfo["icons"]> | undefined> {
  const remoteUrl = typeof descriptor.transport?.url === "string"
    ? safeHttpsUrl(descriptor.transport.url)
    : undefined;
  const icons: NonNullable<McpServerInfo["icons"]> = [];
  for (const icon of info.icons ?? []) {
    if (icons.length >= 2) break;
    if (typeof icon.src !== "string") continue;
    const src = icon.src.trim();
    const mime = typeof icon.mimeType === "string" ? icon.mimeType.toLowerCase() : undefined;
    if (mime && !["image/png", "image/jpeg", "image/jpg"].includes(mime)) continue;

    const safe = await safeIconData(src, remoteUrl);
    if (!safe) continue;

    icons.push({
      src: safe.src,
      mimeType: safe.mimeType,
      sizes: Array.isArray(icon.sizes)
        ? icon.sizes.filter((size): size is string => typeof size === "string").slice(0, 8)
        : undefined,
      theme: icon.theme === "light" || icon.theme === "dark" ? icon.theme : undefined,
    });
  }
  return icons.length ? icons : undefined;
}

function safeHttpsUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

async function normalizeServerMetadata(
  info: Implementation | undefined,
  descriptor: McpDescriptor,
): Promise<ServerMetadata | undefined> {
  if (!info) return undefined;
  const title = typeof info.title === "string" && info.title.trim()
    ? info.title.trim().slice(0, 160)
    : undefined;
  const website = typeof info.websiteUrl === "string" ? safeHttpsUrl(info.websiteUrl) : undefined;
  const version = typeof info.version === "string" && info.version.trim()
    ? info.version.trim().slice(0, 80)
    : undefined;
  return {
    title,
    websiteUrl: website?.toString(),
    version,
    icons: await normalizedIcons(info, descriptor),
    metadataSource: "mcp",
  };
}

async function probeMetadata(descriptor: McpDescriptor): Promise<ServerMetadata | undefined> {
  const config = descriptor.transport;
  if (!config || !descriptor.configuredEnabled) return undefined;
  const client = new Client({ name: "granttap-metadata", version: "0.6.5" });
  try {
    const type = typeof config.type === "string" ? config.type : undefined;
    if ((type === "streamable_http" || type === "http" || type === "sse") &&
        typeof config.url === "string") {
      const url = safeHttpsUrl(config.url);
      if (!url) return undefined;
      const headers = { ...stringRecord(config.http_headers), ...stringRecord(config.headers) };
      for (const [header, variable] of Object.entries(stringRecord(config.env_http_headers))) {
        if (process.env[variable]) headers[header] = process.env[variable]!;
      }
      if (typeof config.bearer_token_env_var === "string" &&
          process.env[config.bearer_token_env_var]) {
        headers.Authorization = `Bearer ${process.env[config.bearer_token_env_var]}`;
      }
      const authenticatedFetch = (input: string | URL | globalThis.Request,
                                  init?: RequestInit) => fetch(input, {
        ...init,
        credentials: "omit",
        headers: { ...headers, ...stringRecord(init?.headers) },
      });
      const transport = type === "sse"
        ? new SSEClientTransport(url, {
            requestInit: { headers, credentials: "omit" },
            fetch: authenticatedFetch,
          })
        : new StreamableHTTPClientTransport(url, {
            requestInit: { headers, credentials: "omit" },
            fetch: authenticatedFetch,
            reconnectionOptions: {
              maxReconnectionDelay: 1_000,
              initialReconnectionDelay: 250,
              reconnectionDelayGrowFactor: 1.2,
              maxRetries: 0,
            },
          });
      await client.connect(transport, { timeout: 7_000 });
    } else if (typeof config.command === "string") {
      const inherited = getDefaultEnvironment();
      const env = { ...inherited, ...stringRecord(config.env) };
      if (Array.isArray(config.env_vars)) {
        for (const variable of config.env_vars) {
          if (typeof variable === "string" && process.env[variable]) env[variable] = process.env[variable]!;
        }
      }
      const transport = new StdioClientTransport({
        command: config.command,
        args: Array.isArray(config.args)
          ? config.args.filter((arg): arg is string => typeof arg === "string")
          : [],
        env,
        cwd: typeof config.cwd === "string" ? config.cwd : undefined,
        stderr: "ignore",
      });
      await client.connect(transport, { timeout: 7_000 });
    } else {
      return undefined;
    }
    return await normalizeServerMetadata(client.getServerVersion(), descriptor);
  } catch {
    return undefined;
  } finally {
    await client.close().catch(() => {});
  }
}

async function refreshDescriptor(descriptor: McpDescriptor): Promise<void> {
  const key = descriptorKey(descriptor);
  const cached = metadataCache.get(key);
  const ttl = cached?.value ? METADATA_SUCCESS_TTL_MS : METADATA_FAILURE_TTL_MS;
  if (cached && Date.now() - cached.at < ttl) return;
  const existing = metadataPending.get(key);
  if (existing) return existing;
  const pending = probeMetadata(descriptor)
    .then((value) => { metadataCache.set(key, { at: Date.now(), value }); })
    .finally(() => { metadataPending.delete(key); });
  metadataPending.set(key, pending);
  return pending;
}

/** Resolve the real serverInfo returned by MCP initialize and cache it. */
export async function refreshMcpMetadataForSession(session: SessionInfo): Promise<void> {
  await Promise.all(descriptorsForSession(session).map(refreshDescriptor));
}

export function mcpServersForSession(session: SessionInfo, disabled: string[]): McpServerInfo[] {
  const descriptors = descriptorsForSession(session);
  void Promise.all(descriptors.map(refreshDescriptor));
  const denied = new Set(disabled);
  return descriptors.map((descriptor) => {
    const configuredEnabled = descriptor.configuredEnabled;
    const base: McpServerInfo = {
      name: descriptor.name,
      configuredEnabled,
      allowed: configuredEnabled && !denied.has(descriptor.name),
      ...(descriptor.authStatus ? { authStatus: descriptor.authStatus } : {}),
    };
    const metadata = metadataCache.get(descriptorKey(descriptor))?.value;
    return metadata ? { ...base, ...metadata } : base;
  });
}

function frontmatter(path: string): SkillInfo | undefined {
  try {
    const body = readFileSync(path, "utf8");
    if (!body.startsWith("---")) return undefined;
    const end = body.indexOf("\n---", 3);
    if (end < 0) return undefined;
    const header = body.slice(3, end);
    const name = header.match(/^name:\s*["']?([^\n"']+)["']?\s*$/m)?.[1]?.trim();
    if (!name) return undefined;
    const description = header.match(/^description:\s*["']?([^\n"']+)["']?\s*$/m)?.[1]?.trim();
    return { name, description };
  } catch {
    return undefined;
  }
}

function skillsIn(root: string): SkillInfo[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: SkillInfo[] = [];
  for (const name of entries) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const skill = frontmatter(join(dir, "SKILL.md"));
    if (skill) out.push(skill);
  }
  return out;
}

/** Repository-scoped skills only: these are the ones connected to the task's folder. */
export function workspaceSkills(cwd: string | undefined): SkillInfo[] {
  if (!cwd) return [];
  const found = new Map<string, SkillInfo>();
  for (const dir of ancestors(cwd)) {
    for (const root of [join(dir, ".agents", "skills"), join(dir, ".claude", "skills")]) {
      for (const skill of skillsIn(root)) if (!found.has(skill.name)) found.set(skill.name, skill);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
