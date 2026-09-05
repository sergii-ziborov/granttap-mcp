/** Public capability telemetry entry point and bounded observation caches. */
import type {
  ActivityEntry,
  CapabilityOutcome,
  CapabilityResourceUsage,
  ObservedCapability,
  RemoteCapabilityUsageEvent,
} from "../../../../packages/protocol/schema";
import { commandPreviewFromInput, commandTextFromInput } from "./telemetry/command-preview";
import {
  clampTokens,
  estimateBaselineTokens,
  estimateTokens,
  supportsFileReadBaseline,
} from "./telemetry/estimation";
import { capabilityIdentity } from "./telemetry/identity";

export * from "./telemetry/command-preview";
export * from "./telemetry/estimation";
export * from "./telemetry/identity";

export const MAX_CAPABILITY_USAGE_EVENTS = 200;
export const MAX_CAPABILITY_OBSERVATIONS_PER_LOG = 200;
export const MAX_PENDING_CAPABILITY_CALLS = 200;
export const MAX_CAPABILITY_USAGE_CANDIDATES = MAX_CAPABILITY_USAGE_EVENTS * 2;
export const MAX_CAPABILITY_USAGE_PAYLOAD_BYTES = 48 * 1024;
const MAX_TOKEN_ESTIMATE = 100_000;
const MAX_DURATION_MS = 60 * 60_000;

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
  outcome: CapabilityOutcome;
  errorClass?: string;
  resource?: CapabilityResourceUsage;
};

const remoteCapabilityEventCache = new WeakMap<
  CapabilityObservation,
  RemoteCapabilityUsageEvent | null
>();

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
    outcome: "unknown",
    ...identity,
    estimatedContextTokens: clampTokens(estimateTokens(pending.input)) || undefined,
  };
}

import { attributedMcpResource } from "../machine-load/mcp-load-cache";
import { attributedAgentResource } from "../machine-load/agent-load-history";

export function observeCapability(
  pending: PendingCapabilityTool,
  resultContent: unknown,
  resultAt: number,
  completion?: { outcome?: CapabilityOutcome; errorClass?: string },
  agent?: string,
): CapabilityObservation | null {
  const observation = pendingCapabilityObservation(pending);
  if (!observation) return null;
  const contextTokens = clampTokens(
    estimateTokens(pending.input) + estimateTokens(resultContent),
  );
  const elapsed = resultAt >= pending.createdAt ? resultAt - pending.createdAt : -1;
  return {
    ...observation,
    outcome: completion?.outcome ?? inferredOutcome(resultContent),
    errorClass: boundedErrorClass(completion?.errorClass),
    estimatedContextTokens: contextTokens || undefined,
    estimatedBaselineTokens: supportsFileReadBaseline(pending.toolName)
      ? estimateBaselineTokens(pending.input, contextTokens, pending.cwd)
      : undefined,
    durationMs: elapsed >= 0 ? Math.min(MAX_DURATION_MS, Math.round(elapsed)) : undefined,
    // A call cannot be measured after the fact. An MCP server outlives its
    // calls, so it can be asked directly; a built-in tool does not, so the
    // samples taken while it ran are what describe it.
    resource: observation.mcpServer
      ? attributedMcpResource(observation.mcpServer, resultAt, Date.now())
      : agent
        ? attributedAgentResource(agent, pending.createdAt, resultAt)
        : undefined,
  };
}

function inferredOutcome(value: unknown): CapabilityOutcome {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    const status = String(row.status ?? "").toLowerCase();
    if (row.cancelled === true || status === "cancelled" || status === "canceled") return "cancelled";
    if (row.success === false || row.is_error === true || row.isError === true || row.error != null
      || ["error", "failed", "failure"].includes(status)) return "error";
  }
  return "success";
}

function boundedErrorClass(value: string | undefined): string | undefined {
  const clean = value?.trim().replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);
  return clean || undefined;
}

/**
 * The command a shell call ran, by its first real word: `npm`, `git`, `rg` —
 * not `Bash`. A usage screen that listed every shell call as Bash could not
 * say which tool was slow or failing, which is the only thing it is for.
 */
export function commandName(preview: string | undefined | null): string | undefined {
  if (!preview) return undefined;
  const prefixes = new Set(["sudo", "env", "exec", "time", "nohup", "command", "builtin", "xargs"]);
  for (const segment of preview.split(/\s*(?:&&|\|\||;|\|)\s*/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let index = 0;
    while (index < words.length) {
      const word = words[index]!;
      if (word === "cd") { index += 2; continue; }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || prefixes.has(word)) { index += 1; continue; }
      break;
    }
    const word = words[index];
    if (!word) continue;
    const leaf = word.split("/").pop() ?? word;
    // A shouting name is a variable, not a command: a preview cut short at
    // "DEVELOPER_DIR" must not name the call DEVELOPER_DIR.
    if (/^[A-Z_][A-Z0-9_]*$/.test(leaf)) continue;
    if (/^[A-Za-z0-9._+-]{1,40}$/.test(leaf) && !/^[-.]/.test(leaf)) return leaf;
  }
  return undefined;
}

export function toObservedCapability(
  observation: CapabilityObservation,
): ObservedCapability {
  const kind = observation.mcpServer ? "mcp" : observation.skill ? "skill" : "cli";
  const toolName = observation.toolName.trim().slice(0, 240);
  const commandPreview =
    kind === "cli" ? commandPreviewFromInput(observation.commandPreview) ?? undefined : undefined;
  return {
    kind,
    name: (observation.mcpServer ?? observation.skill ?? commandName(kind === "cli" ? commandTextFromInput(observation.commandPreview) : undefined) ?? toolName).trim().slice(0, 160),
    toolName,
    commandPreview,
    estimatedContextTokens: observation.estimatedContextTokens,
    estimatedBaselineTokens: observation.estimatedBaselineTokens,
    durationMs: observation.durationMs,
    outcome: observation.outcome,
    errorClass: observation.errorClass,
    resource: observation.resource,
  };
}

export function activityTelemetry(
  observation: CapabilityObservation,
): Partial<Pick<ActivityEntry, "estimatedContextTokens" | "capabilities" | "durationMs">> {
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
  const remotePreview =
    kind === "cli" ? commandPreviewFromInput(observation.commandPreview) ?? undefined : undefined;
  const name = (observation.mcpServer ?? observation.skill ?? commandName(remotePreview) ?? observation.toolName).trim();
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
    outcome: observation.outcome,
    errorClass: observation.errorClass,
    resource: observation.resource,
  };
  remoteCapabilityEventCache.set(observation, event);
  return event;
}

function richness(event: RemoteCapabilityUsageEvent): number {
  return (event.durationMs != null ? 4 : 0) + (event.outcome !== "unknown" ? 4 : 0) +
    (event.resource != null ? 3 : 0) +
    (event.estimatedBaselineTokens != null ? 2 : 0) +
    (event.commandPreview != null ? 1 : 0) +
    (event.estimatedContextTokens ?? 0) / MAX_TOKEN_ESTIMATE;
}

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

export function rememberCapabilityUsageCandidate(
  candidates: RemoteCapabilityUsageEvent[],
  event: RemoteCapabilityUsageEvent,
): void {
  candidates.push(event);
  if (candidates.length < MAX_CAPABILITY_USAGE_CANDIDATES) return;
  const compacted = limitCapabilityUsageEvents(candidates);
  candidates.splice(0, candidates.length, ...compacted);
}
