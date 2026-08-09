/**
 * Result-aware MCP/skill telemetry shared by the provider-specific log readers.
 * Estimates describe ordinary chat-context occupancy, never provider billing.
 */
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type {
  ActivityEntry,
  ObservedCapability,
  RemoteCapabilityUsageEvent,
} from "../../../../packages/protocol/schema";

export const MAX_CAPABILITY_USAGE_EVENTS = 200;
export const MAX_CAPABILITY_OBSERVATIONS_PER_LOG = 200;
export const MAX_PENDING_CAPABILITY_CALLS = 200;
export const MAX_CAPABILITY_USAGE_CANDIDATES = MAX_CAPABILITY_USAGE_EVENTS * 2;
/** Keep the plaintext status comfortably below relay/proxy frame limits. */
export const MAX_CAPABILITY_USAGE_PAYLOAD_BYTES = 48 * 1024;
export const MAX_COMMAND_PREVIEW_LENGTH = 160;
const MAX_TOKEN_ESTIMATE = 100_000;
const IMAGE_TOKEN_ESTIMATE = 1_600;
const MAX_DURATION_MS = 60 * 60_000;

function hasImageMagic(value: string): boolean {
  const trimmed = value.trimStart();
  if (/^data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,/i.test(trimmed)) {
    return true;
  }
  const prefix = trimmed.slice(0, 128).replace(/\s+/g, "");
  if (prefix.length < 8 || !/^[A-Za-z0-9+/=]+$/.test(prefix)) return false;
  try {
    const bytes = Buffer.from(prefix.slice(0, 96), "base64");
    const ascii = bytes.toString("ascii");
    return (
      (bytes[0] === 0x89 && ascii.slice(1, 4) === "PNG") ||
      (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
      ascii.startsWith("GIF87a") ||
      ascii.startsWith("GIF89a") ||
      (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") ||
      ascii.startsWith("BM") ||
      (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 0x2a) ||
      (bytes[0] === 0 && bytes[1] === 0 && [1, 2].includes(bytes[2] ?? -1) && bytes[3] === 0)
    );
  } catch {
    return false;
  }
}

function structuredImageMime(record: Record<string, unknown>): boolean {
  const source =
    record.source && typeof record.source === "object"
      ? (record.source as Record<string, unknown>)
      : undefined;
  const candidates = [
    record.type,
    record.media_type,
    record.mediaType,
    record.mime_type,
    record.mimeType,
    record.content_type,
    record.contentType,
    source?.media_type,
    source?.mediaType,
    source?.mime_type,
    source?.mimeType,
    source?.content_type,
    source?.contentType,
    source?.type,
  ];
  return candidates.some(
    (candidate) =>
      typeof candidate === "string" && /^image\/[a-z0-9.+-]+(?:\s*;|$)/i.test(candidate),
  );
}

export type PendingCapabilityTool = {
  sourceId: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  createdAt: number;
  cwd?: string;
};

export type CapabilityObservation = {
  sourceId: string;
  sessionId: string;
  toolName: string;
  createdAt: number;
  mcpServer?: string;
  skill?: string;
  cli?: true;
  commandPreview?: string;
  estimatedContextTokens?: number;
  estimatedBaselineTokens?: number;
  durationMs?: number;
};

/** Parsed provider observations are immutable cache entries; convert each once. */
const remoteCapabilityEventCache = new WeakMap<
  CapabilityObservation,
  RemoteCapabilityUsageEvent | null
>();

/** Retain only the newest unresolved calls while parsing adversarially large logs. */
export function rememberPendingCapabilityCall<T>(
  pending: Map<string, T>,
  key: string,
  value: T,
): void {
  if (pending.has(key)) pending.delete(key);
  pending.set(key, value);
  while (pending.size > MAX_PENDING_CAPABILITY_CALLS) {
    const oldest = pending.keys().next().value as string | undefined;
    if (oldest == null) break;
    pending.delete(oldest);
  }
}

/** Maintain a newest-first, per-log observation cache without materializing all calls. */
export function rememberCapabilityObservation(
  observations: CapabilityObservation[],
  observation: CapabilityObservation,
): void {
  const duplicate = observations.findIndex(
    (candidate) => candidate.sourceId === observation.sourceId,
  );
  if (duplicate >= 0) {
    if (observations[duplicate]!.createdAt > observation.createdAt) return;
    observations.splice(duplicate, 1);
  }
  const insertAt = observations.findIndex(
    (candidate) => candidate.createdAt < observation.createdAt,
  );
  if (insertAt < 0) observations.push(observation);
  else observations.splice(insertAt, 0, observation);
  if (observations.length > MAX_CAPABILITY_OBSERVATIONS_PER_LOG) {
    observations.length = MAX_CAPABILITY_OBSERVATIONS_PER_LOG;
  }
}

export function parseMcpToolName(
  toolName: string,
): { server: string; tool: string } | null {
  // Server ids may contain single underscores; `__` is the delimiter.
  const match = /^mcp__(.+?)__(.+)$/i.exec(toolName.trim());
  const server = match?.[1]?.trim();
  const tool = match?.[2]?.trim();
  return server && tool ? { server, tool } : null;
}

export function skillNameFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const value = (input as Record<string, unknown>).skill;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function capabilityIdentity(
  toolName: string,
  input: unknown,
): { mcpServer?: string; skill?: string; cli?: true; commandPreview?: string } | null {
  const mcp = parseMcpToolName(toolName);
  if (mcp) return { mcpServer: mcp.server };

  const namedSkill = /^(?:skill__|Skill\()(.+?)\)?$/i.exec(toolName.trim())?.[1]?.trim();
  if (namedSkill) return { skill: namedSkill };
  if (/^Skill$/i.test(toolName.trim())) {
    const skill = skillNameFromInput(input);
    return skill ? { skill } : null;
  }
  if (isCliToolName(toolName)) {
    return { cli: true, commandPreview: commandPreviewFromInput(input) ?? undefined };
  }
  return null;
}

const CLI_TOOL_NAMES = new Set([
  "bash",
  "shell",
  "powershell",
  "terminal",
  "exec_command",
  "execute_command",
  "local_shell_call",
  "run_command",
  "run_in_terminal",
  "run_terminal_cmd",
  "shell_command",
]);

function isCliToolName(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  if (CLI_TOOL_NAMES.has(normalized)) return true;
  const leaf = normalized.split(/[.:/]/).at(-1);
  return leaf != null && CLI_TOOL_NAMES.has(leaf);
}

function commandValue(input: unknown, depth = 0): string | null {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    const parts = input.filter((item): item is string => typeof item === "string");
    return parts.length === input.length && parts.length > 0 ? parts.join(" ") : null;
  }
  if (!input || typeof input !== "object" || depth > 1) return null;
  const record = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "shell_command", "shellCommand", "script"]) {
    const value = commandValue(record[key], depth + 1);
    if (value) return value;
  }
  return commandValue(record.action, depth + 1);
}

const REDACTED_COMMAND_VALUE = "[REDACTED]";
const SENSITIVE_NAME =
  "(?:api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|token|auth(?:orization)?|password|passwd|pwd|credential(?:s)?|client[_-]?secret|private[_-]?key)";
const SENSITIVE_CONFIG_KEY = `[^\\s=;&|]*(?:${SENSITIVE_NAME})[^\\s=;&|]*`;
const SHELL_ARGUMENT_VALUE = `(?:"[^"]*"|'[^']*'|[^\\s;&|]+)`;

/**
 * Command input commonly embeds credentials in env assignments, flags,
 * headers, JSON, or URLs. Preview is analytics, so prefer false-positive
 * redaction over retaining a secret in the encrypted wire/local history.
 */
function redactCommandSecrets(raw: string): string {
  let value = raw;
  // A pasted private key has no safe preview suffix.
  value = value.replace(
    /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*/gi,
    REDACTED_COMMAND_VALUE,
  );
  // Environment assignments, including provider-prefixed names such as
  // OPENAI_API_KEY and GITHUB_TOKEN.
  value = value.replace(
    new RegExp(
      `(\\b[A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|AUTH)[A-Za-z0-9_]*\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s;&|]+)`,
      "gi",
    ),
    `$1${REDACTED_COMMAND_VALUE}`,
  );
  // Common basic-auth syntax. Scope short `-u` to curl so unrelated command
  // flags retain a useful preview while the whole user:password value is gone.
  value = value.replace(
    new RegExp(
      `(\\bcurl\\b(?:(?![;&|]).)*?\\s(?:-u|--user|--proxy-user)(?:\\s*=\\s*|\\s+))${SHELL_ARGUMENT_VALUE}`,
      "gi",
    ),
    `$1${REDACTED_COMMAND_VALUE}`,
  );
  // Password flags are also frequently attached (`mysql -psecret`). Prefer an
  // occasional false-positive redaction to persisting the attached value.
  value = value.replace(
    new RegExp(`((?:^|\\s)-p)(?!\\s|$)${SHELL_ARGUMENT_VALUE}`, "g"),
    `$1${REDACTED_COMMAND_VALUE}`,
  );
  // Config setters put the sensitive *name* before a positional value instead
  // of using a normal flag: AWS credentials and npm registry auth are common.
  value = value.replace(
    new RegExp(
      `(\\b(?:aws\\s+configure\\s+set|npm\\s+(?:config\\s+)?set)\\s+${SENSITIVE_CONFIG_KEY}(?:\\s*=\\s*|\\s+))${SHELL_ARGUMENT_VALUE}`,
      "gi",
    ),
    `$1${REDACTED_COMMAND_VALUE}`,
  );
  // Named CLI options: --token value, --api-key=value, etc.
  value = value.replace(
    new RegExp(
      `((?:^|\\s)--?${SENSITIVE_NAME}(?:\\s*=\\s*|\\s+))(?:"[^"]*"|'[^']*'|[^\\s;&|]+)`,
      "gi",
    ),
    `$1${REDACTED_COMMAND_VALUE}`,
  );
  // Headers and JSON-like key/value pairs, quoted or unquoted.
  value = value.replace(
    new RegExp(
      `((?:${SENSITIVE_NAME}|x-api-key|proxy-authorization)\\s*:\\s*)(?:bearer\\s+|basic\\s+)?(?:"[^"]*"|'[^']*'|[^\\s,;}]+)`,
      "gi",
    ),
    `$1${REDACTED_COMMAND_VALUE}`,
  );
  value = value.replace(
    new RegExp(
      `(["']?(?:${SENSITIVE_NAME})["']?\\s*:\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;}]+)`,
      "gi",
    ),
    `$1${REDACTED_COMMAND_VALUE}`,
  );
  // URL userinfo and sensitive query parameters.
  value = value.replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
    `$1${REDACTED_COMMAND_VALUE}@`,
  );
  value = value.replace(
    new RegExp(`([?&]${SENSITIVE_NAME}=)[^&#\\s]+`, "gi"),
    `$1${REDACTED_COMMAND_VALUE}`,
  );
  // High-confidence provider token formats can appear without a label.
  value = value
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g, REDACTED_COMMAND_VALUE)
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gi, REDACTED_COMMAND_VALUE)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED_COMMAND_VALUE)
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi, REDACTED_COMMAND_VALUE)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED_COMMAND_VALUE)
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      REDACTED_COMMAND_VALUE,
    );
  return value;
}

/** Extract only a bounded one-line prefix from CLI input, never tool output. */
export function commandPreviewFromInput(input: unknown): string | null {
  const raw = commandValue(input);
  if (!raw) return null;
  const collapsed = redactCommandSecrets(raw)
    .replace(/[\s\u0000-\u001f\u007f]+/g, " ")
    .trim();
  if (!collapsed) return null;
  return collapsed.slice(0, MAX_COMMAND_PREVIEW_LENGTH);
}

/** Approximate normal context tokens while bounding image/base64 payloads. */
export function estimateTokens(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "string") {
    if (hasImageMagic(value)) return IMAGE_TOKEN_ESTIMATE;
    return Math.ceil(Buffer.byteLength(value, "utf8") / 4);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return Math.ceil(String(value).length / 4);
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + estimateTokens(item), 0);
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const source =
      record.source && typeof record.source === "object"
        ? (record.source as Record<string, unknown>)
        : undefined;
    const encodedImage = [
      record.data,
      record.image_url,
      record.imageUrl,
      source?.data,
      source?.url,
    ].some((candidate) => typeof candidate === "string" && hasImageMagic(candidate));
    if (
      record.type === "image" ||
      record.type === "input_image" ||
      structuredImageMime(record) ||
      encodedImage
    ) {
      return IMAGE_TOKEN_ESTIMATE;
    }
    if (typeof record.text === "string" && Object.keys(record).length <= 3) {
      return estimateTokens(record.text);
    }
    try {
      return Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 4);
    } catch {
      return 0;
    }
  }
  return 0;
}

function clampTokens(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(MAX_TOKEN_ESTIMATE, Math.round(value));
}

function inputPath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const raw = record.file_path ?? record.path ?? record.filePath ?? record.filename;
  if (typeof raw !== "string" || !raw.trim() || raw.length > 4_096) return null;
  return raw.trim();
}

function estimateBaselineTokens(
  input: unknown,
  contextTokens: number,
  cwd?: string,
): number | undefined {
  const raw = inputPath(input);
  if (!raw || /^(?:https?|data):/i.test(raw)) return undefined;
  if (!isAbsolute(raw) && !cwd) return undefined;
  const file = isAbsolute(raw) ? raw : resolve(cwd!, raw);
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size <= 0) return undefined;
    const baseline = clampTokens(stat.size / 4);
    return baseline > contextTokens ? baseline : undefined;
  } catch {
    return undefined;
  }
}

function supportsFileReadBaseline(toolName: string): boolean {
  const operation = (parseMcpToolName(toolName)?.tool ?? toolName).toLowerCase();
  if (
    /(?:^|[_-])(write|edit|patch|update|delete|remove|create|upload|move|rename)(?:$|[_-])/.test(
      operation,
    )
  ) {
    return false;
  }
  return /(?:^|[_-])(read|view|preview|search|query|find|inspect|context|fetch|get|open|load|list)(?:$|[_-])/.test(
    operation,
  );
}

/** Input-only observation retained until a matching result is logged. */
export function pendingCapabilityObservation(
  pending: PendingCapabilityTool,
): CapabilityObservation | null {
  const identity = capabilityIdentity(pending.toolName, pending.input);
  if (!identity) return null;
  return {
    sourceId: pending.sourceId,
    sessionId: pending.sessionId,
    toolName: pending.toolName,
    createdAt: pending.createdAt,
    ...identity,
    estimatedContextTokens: clampTokens(estimateTokens(pending.input)) || undefined,
  };
}

/** Enrich a pending call with result tokens, baseline, and elapsed wall time. */
export function observeCapability(
  pending: PendingCapabilityTool,
  resultContent: unknown,
  resultAt: number,
): CapabilityObservation | null {
  const observation = pendingCapabilityObservation(pending);
  if (!observation) return null;
  const contextTokens = clampTokens(
    estimateTokens(pending.input) + estimateTokens(resultContent),
  );
  const elapsed = resultAt >= pending.createdAt ? resultAt - pending.createdAt : -1;
  return {
    ...observation,
    estimatedContextTokens: contextTokens || undefined,
    estimatedBaselineTokens: supportsFileReadBaseline(pending.toolName)
      ? estimateBaselineTokens(pending.input, contextTokens, pending.cwd)
      : undefined,
    durationMs:
      elapsed >= 0
        ? Math.min(MAX_DURATION_MS, Math.round(elapsed))
        : undefined,
  };
}

export function toObservedCapability(
  observation: CapabilityObservation,
): ObservedCapability {
  const kind = observation.mcpServer ? "mcp" : observation.skill ? "skill" : "cli";
  const toolName = observation.toolName.trim().slice(0, 240);
  return {
    kind,
    name: (observation.mcpServer ?? observation.skill ?? toolName).trim().slice(0, 160),
    toolName,
    commandPreview:
      kind === "cli" ? commandPreviewFromInput(observation.commandPreview) ?? undefined : undefined,
    estimatedContextTokens: observation.estimatedContextTokens,
    estimatedBaselineTokens: observation.estimatedBaselineTokens,
    durationMs: observation.durationMs,
  };
}

export function activityTelemetry(
  observation: CapabilityObservation,
): Partial<
  Pick<ActivityEntry, "estimatedContextTokens" | "capabilities" | "durationMs">
> {
  return {
    estimatedContextTokens: observation.estimatedContextTokens,
    capabilities: [toObservedCapability(observation)],
    durationMs: observation.durationMs,
  };
}

export function toRemoteCapabilityUsageEvent(
  observation: CapabilityObservation,
): RemoteCapabilityUsageEvent | null {
  const cached = remoteCapabilityEventCache.get(observation);
  if (cached !== undefined) return cached;
  const kind = observation.mcpServer
    ? "mcp"
    : observation.skill
      ? "skill"
      : observation.cli
        ? "cli"
        : null;
  const name = (observation.mcpServer ?? observation.skill ?? observation.toolName).trim();
  const toolName = observation.toolName.trim();
  const sessionId = observation.sessionId.trim();
  if (!kind || !name || !toolName || !sessionId || sessionId.length > 256) {
    remoteCapabilityEventCache.set(observation, null);
    return null;
  }
  const event: RemoteCapabilityUsageEvent = {
    sourceId: observation.sourceId.slice(0, 512),
    sessionId,
    kind,
    name: name.slice(0, 160),
    toolName: toolName.slice(0, 240),
    commandPreview:
      kind === "cli" ? commandPreviewFromInput(observation.commandPreview) ?? undefined : undefined,
    createdAt: observation.createdAt,
    estimatedContextTokens: observation.estimatedContextTokens,
    estimatedBaselineTokens: observation.estimatedBaselineTokens,
    durationMs: observation.durationMs,
  };
  remoteCapabilityEventCache.set(observation, event);
  return event;
}

function richness(event: RemoteCapabilityUsageEvent): number {
  return (event.durationMs != null ? 4 : 0) +
    (event.estimatedBaselineTokens != null ? 2 : 0) +
    (event.commandPreview != null ? 1 : 0) +
    (event.estimatedContextTokens ?? 0) / MAX_TOKEN_ESTIMATE;
}

/** Deduplicate, newest-first, then enforce both count and serialized-byte caps. */
export function limitCapabilityUsageEvents(
  events: RemoteCapabilityUsageEvent[],
): RemoteCapabilityUsageEvent[] {
  const bySource = new Map<string, RemoteCapabilityUsageEvent>();
  for (const event of events) {
    const key = `${event.roomId ?? ""}\u0000${event.sourceId}`;
    const previous = bySource.get(key);
    if (!previous || richness(event) > richness(previous)) bySource.set(key, event);
  }
  const sorted = [...bySource.values()].sort((a, b) => b.createdAt - a.createdAt);
  const out: RemoteCapabilityUsageEvent[] = [];
  let bytes = Buffer.byteLength(
    JSON.stringify({ type: "capability.usage.status", events: [], generatedAt: Date.now() }),
    "utf8",
  );
  for (const event of sorted) {
    if (out.length >= MAX_CAPABILITY_USAGE_EVENTS) break;
    const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8") + (out.length ? 1 : 0);
    if (bytes + eventBytes > MAX_CAPABILITY_USAGE_PAYLOAD_BYTES) break;
    out.push(event);
    bytes += eventBytes;
  }
  return out;
}

/** Bound scan-wide candidates by periodically applying the final dedupe/byte policy. */
export function rememberCapabilityUsageCandidate(
  candidates: RemoteCapabilityUsageEvent[],
  event: RemoteCapabilityUsageEvent,
): void {
  candidates.push(event);
  if (candidates.length < MAX_CAPABILITY_USAGE_CANDIDATES) return;
  const compacted = limitCapabilityUsageEvents(candidates);
  candidates.splice(0, candidates.length, ...compacted);
}
