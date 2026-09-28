/** Public capability telemetry entry point and bounded observation caches. */
import type {
  ActivityEntry,
  CapabilityOutcome,
  CapabilityResourceUsage,
  ObservedCapability,
  RemoteCapabilityUsageEvent,
} from "../../../../../packages/protocol/schema";
import { commandPreviewFromInput, commandTextFromInput } from "./command-preview";
import {
  clampTokens,
  estimateBaselineTokens,
  estimateTokens,
  supportsFileReadBaseline,
} from "./estimation";
import { capabilityIdentity } from "./identity";

export * from "./command-preview";
export * from "./estimation";
export * from "./identity";
export * from "./wire-budget";

export const MAX_CAPABILITY_OBSERVATIONS_PER_LOG = 200;
export const MAX_PENDING_CAPABILITY_CALLS = 200;
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

import { attributedMcpResource } from "../../machine-load/mcp/cache";
import { attributedAgentResource } from "../../machine-load/host/agent-load-history";

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
    let structural = false;
    while (index < words.length) {
      const word = words[index]!;
      if (word === "cd") { index += 2; continue; }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || prefixes.has(word)) { index += 1; continue; }
      // "then rm -rf build" ran rm; the keyword only introduced it.
      if (SHELL_LEADERS.has(word)) { index += 1; continue; }
      // "if [ -f x ]", "export FOO=1", "for f in …" ran nothing themselves:
      // what they ran is in a later segment, after "then" or "do".
      if (SHELL_STRUCTURE.has(word)) { structural = true; break; }
      break;
    }
    if (structural) continue;
    const word = words[index];
    if (!word) continue;
    const leaf = word.split("/").pop() ?? word;
    // A shouting name is a variable, not a command: a preview cut short at
    // "DEVELOPER_DIR" must not name the call DEVELOPER_DIR.
    if (/^[A-Z_][A-Z0-9_]*$/.test(leaf)) continue;
    // A number is an argument that lost its command, never a command.
    if (/^\d+$/.test(leaf)) continue;
    if (/^[A-Za-z0-9._+-]{1,40}$/.test(leaf) && !/^[-.]/.test(leaf)) return leaf;
  }
  return undefined;
}

/** Keywords that introduce the command that follows them in the same segment. */
const SHELL_LEADERS = new Set(["then", "do", "else", "elif", "!", "{", "(", "time"]);

/**
 * Words that structure a shell script without running anything a person
 * would recognise as the call: conditions, loops, declarations, tests.
 */
const SHELL_STRUCTURE = new Set([
  "if", "for", "while", "until", "case", "select", "function", "fi", "done", "esac", "in",
  "export", "set", "unset", "local", "declare", "typeset", "readonly", "alias", "unalias",
  "source", ".", "eval", "wait", "shift", "return", "exit", "true", "false", ":", "read",
  "trap", "test", "[", "[[", "]", "]]", "}", ")", "pushd", "popd", "shopt", "setopt",
]);

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
