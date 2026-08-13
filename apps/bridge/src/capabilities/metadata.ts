import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Implementation } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerInfo } from "../../../../packages/protocol/schema";
import type { McpDescriptor, ServerMetadata } from "./types";

const metadataCache = new Map<string, { at: number; value?: ServerMetadata }>();
const metadataPending = new Map<string, Promise<void>>();
const SUCCESS_TTL_MS = 6 * 60 * 60_000;
const FAILURE_TTL_MS = 10 * 60_000;
const MAX_ICON_BYTES = 16 * 1024;

export async function refreshDescriptorMetadata(descriptor: McpDescriptor): Promise<void> {
  const key = descriptorKey(descriptor);
  const cached = metadataCache.get(key);
  const ttl = cached?.value ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
  if (cached && Date.now() - cached.at < ttl) return;
  const existing = metadataPending.get(key);
  if (existing) return existing;
  const pending = probeMetadata(descriptor)
    .then((value) => { metadataCache.set(key, { at: Date.now(), value }); })
    .finally(() => { metadataPending.delete(key); });
  metadataPending.set(key, pending);
  return pending;
}

export function cachedMetadata(descriptor: McpDescriptor): ServerMetadata | undefined {
  return metadataCache.get(descriptorKey(descriptor))?.value;
}

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

async function probeMetadata(descriptor: McpDescriptor): Promise<ServerMetadata | undefined> {
  const config = descriptor.transport;
  if (!config || !descriptor.configuredEnabled) return undefined;
  const client = new Client({ name: "granttap-metadata", version: "0.6.5" });
  try {
    await connectMetadataClient(client, descriptor);
    return await normalizeServerMetadata(client.getServerVersion(), descriptor);
  } catch {
    return undefined;
  } finally {
    await client.close().catch(() => {});
  }
}

async function connectMetadataClient(client: Client, descriptor: McpDescriptor): Promise<void> {
  const config = descriptor.transport!;
  const type = typeof config.type === "string" ? config.type : undefined;
  if ((type === "streamable_http" || type === "http" || type === "sse") && typeof config.url === "string") {
    const url = safeHttpsUrl(config.url);
    if (!url) throw new Error("unsafe MCP URL");
    const headers = requestHeaders(config);
    const fetch = authenticatedFetch(headers);
    const transport = type === "sse"
      ? new SSEClientTransport(url, { requestInit: { headers, credentials: "omit" }, fetch })
      : new StreamableHTTPClientTransport(url, {
          requestInit: { headers, credentials: "omit" },
          fetch,
          reconnectionOptions: {
            maxReconnectionDelay: 1_000,
            initialReconnectionDelay: 250,
            reconnectionDelayGrowFactor: 1.2,
            maxRetries: 0,
          },
        });
    await client.connect(transport, { timeout: 7_000 });
    return;
  }
  if (typeof config.command !== "string") throw new Error("unsupported MCP transport");
  const env = { ...getDefaultEnvironment(), ...stringRecord(config.env) };
  if (Array.isArray(config.env_vars)) {
    for (const variable of config.env_vars) {
      if (typeof variable === "string" && process.env[variable]) env[variable] = process.env[variable]!;
    }
  }
  const transport = new StdioClientTransport({
    command: config.command,
    args: Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === "string") : [],
    env,
    cwd: typeof config.cwd === "string" ? config.cwd : undefined,
    stderr: "ignore",
  });
  await client.connect(transport, { timeout: 7_000 });
}

function requestHeaders(config: NonNullable<McpDescriptor["transport"]>): Record<string, string> {
  const headers = { ...stringRecord(config.http_headers), ...stringRecord(config.headers) };
  for (const [header, variable] of Object.entries(stringRecord(config.env_http_headers))) {
    if (process.env[variable]) headers[header] = process.env[variable]!;
  }
  if (typeof config.bearer_token_env_var === "string" && process.env[config.bearer_token_env_var]) {
    headers.Authorization = `Bearer ${process.env[config.bearer_token_env_var]}`;
  }
  return headers;
}

function authenticatedFetch(headers: Record<string, string>) {
  return (input: string | URL | globalThis.Request, init?: RequestInit) => fetch(input, {
    ...init,
    credentials: "omit",
    headers: { ...headers, ...stringRecord(init?.headers) },
  });
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function normalizeServerMetadata(info: Implementation | undefined, descriptor: McpDescriptor): Promise<ServerMetadata | undefined> {
  if (!info) return undefined;
  const title = typeof info.title === "string" && info.title.trim() ? info.title.trim().slice(0, 160) : undefined;
  const website = typeof info.websiteUrl === "string" ? safeHttpsUrl(info.websiteUrl) : undefined;
  const version = typeof info.version === "string" && info.version.trim() ? info.version.trim().slice(0, 80) : undefined;
  return { title, websiteUrl: website?.toString(), version, icons: await normalizedIcons(info, descriptor), metadataSource: "mcp" };
}

async function normalizedIcons(info: Implementation, descriptor: McpDescriptor): Promise<NonNullable<McpServerInfo["icons"]> | undefined> {
  const remoteUrl = typeof descriptor.transport?.url === "string" ? safeHttpsUrl(descriptor.transport.url) : undefined;
  const icons: NonNullable<McpServerInfo["icons"]> = [];
  for (const icon of info.icons ?? []) {
    if (icons.length >= 2) break;
    if (typeof icon.src !== "string") continue;
    const mime = typeof icon.mimeType === "string" ? icon.mimeType.toLowerCase() : undefined;
    if (mime && !["image/png", "image/jpeg", "image/jpg"].includes(mime)) continue;
    const safe = await safeIconData(icon.src.trim(), remoteUrl);
    if (!safe) continue;
    icons.push({
      src: safe.src,
      mimeType: safe.mimeType,
      sizes: Array.isArray(icon.sizes) ? icon.sizes.filter((size): size is string => typeof size === "string").slice(0, 8) : undefined,
      theme: icon.theme === "light" || icon.theme === "dark" ? icon.theme : undefined,
    });
  }
  return icons.length ? icons : undefined;
}

async function safeIconData(src: string, remoteUrl?: URL): Promise<{ src: string; mimeType: "image/png" | "image/jpeg" } | undefined> {
  const dataMatch = src.match(/^data:image\/(png|jpe?g);base64,([a-z0-9+/=\s]+)$/i);
  if (dataMatch) return validatedDataIcon(dataMatch[2]!);
  const initial = safeHttpsUrl(src);
  if (!initial || (remoteUrl && initial.origin !== remoteUrl.origin)) return undefined;
  return fetchIcon(initial);
}

function validatedDataIcon(encoded: string): { src: string; mimeType: "image/png" | "image/jpeg" } | undefined {
  const clean = encoded.replace(/\s/g, "");
  if (clean.length > Math.ceil(MAX_ICON_BYTES * 4 / 3) + 4) return undefined;
  const bytes = Buffer.from(clean, "base64");
  const mimeType = imageMime(bytes);
  return mimeType && bytes.length <= MAX_ICON_BYTES ? { src: `data:${mimeType};base64,${bytes.toString("base64")}`, mimeType } : undefined;
}

async function fetchIcon(initial: URL): Promise<{ src: string; mimeType: "image/png" | "image/jpeg" } | undefined> {
  let current = initial;
  try {
    for (let redirect = 0; redirect <= 2; redirect += 1) {
      const response = await fetch(current, { method: "GET", redirect: "manual", credentials: "omit", headers: { Accept: "image/png, image/jpeg" }, signal: AbortSignal.timeout(5_000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        const target = location ? safeHttpsUrl(new URL(location, current).toString()) : undefined;
        if (!target || target.origin !== initial.origin) return undefined;
        current = target;
        continue;
      }
      if (!response.ok || Number(response.headers.get("content-length") ?? 0) > MAX_ICON_BYTES) return undefined;
      const bytes = await readResponseBodyLimited(response);
      const mimeType = bytes && imageMime(bytes);
      return mimeType && bytes ? { src: `data:${mimeType};base64,${bytes.toString("base64")}`, mimeType } : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function readResponseBodyLimited(response: Response): Promise<Buffer | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ICON_BYTES) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

function imageMime(bytes: Buffer): "image/png" | "image/jpeg" | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? "image/jpeg" : undefined;
}

function safeHttpsUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url : undefined;
  } catch {
    return undefined;
  }
}
