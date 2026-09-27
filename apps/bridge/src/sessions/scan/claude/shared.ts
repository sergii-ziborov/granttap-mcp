import { diffPreviewFromInput, patchStatsByToolUse, sensitivePath, statsFromInput } from "../../support/edit-stats";
import { redactSecrets } from "../../telemetry/command-preview";
import { recordObservedWrite, writtenPaths } from "../../../mesh/observed/writes";
/**
 * Claude Code session logs:
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 *   assistant entries carry `message.usage` (input/output/cache).
 */
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  ActivityEntry,
  ChildThreadInfo,
  SessionInfo,
} from "../../../../../../packages/protocol/schema";
import {
  claudeProjectsRoot,
  recentLogs,
  safeParse,
  stateFor,
  TOKEN_WINDOW_MS,
  ts,
  type Scan,
} from "../../support/common";
import {
  classifyTool,
  estimateTokens,
  pushEntry,
  toolDescription,
  toolSummary,
} from "../../support/activity-helpers";
import {
  aggregateChildThreads,
  childEntryFields,
  childTitle,
} from "../../support/child-threads";
import {
  activityTelemetry,
  observeCapability,
  pendingCapabilityObservation,
  rememberCapabilityObservation,
  rememberPendingCapabilityCall,
  type CapabilityObservation,
  type PendingCapabilityTool,
} from "../../telemetry";

export type CachedClaudeSummary = {
  mtimeMs: number;
  size: number;
  childFingerprint: string;
  session: SessionInfo;
  tokensSession: number;
  observations: CapabilityObservation[];
};

export const claudeSummaryCache = new Map<string, CachedClaudeSummary>();
export const claudeLogPathBySession = new Map<string, string>();
export const claudeChildLogPathsBySession = new Map<string, string[]>();

export function claudeTranscriptPaths(sessionId: string): string[] {
  const parent = claudeLogPathBySession.get(sessionId) ?? claudeLogPath(sessionId);
  return parent ? [parent, ...(claudeChildLogPathsBySession.get(sessionId) ?? [])] : [];
}

export function claudeChildLogPaths(parentFile: string, sessionId: string): string[] {
  return recentLogs(join(dirname(parentFile), sessionId, "subagents"), 4)
    .filter((path) => basename(path).startsWith("agent-"));
}

export function childLogsFingerprint(paths: string[]): string {
  return paths.map((path) => {
    try {
      const stat = statSync(path);
      return `${path}\u0000${stat.mtimeMs}\u0000${stat.size}`;
    } catch {
      return `${path}\u0000missing`;
    }
  }).join("\u0001");
}

export function readLines(path: string): string[] | undefined {
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch {
    return undefined;
  }
}

export function claudeChildSummary(
  path: string,
  parentSessionId: string,
  lines: string[],
): ChildThreadInfo {
  let threadId = basename(path, ".jsonl").replace(/^agent-/, "");
  let title: string | undefined;
  let startedAt = 0;
  let lastActivityAt = 0;
  let tokensSession = 0;
  let tokensLastTurn = 0;
  for (const line of lines) {
    const row = safeParse(line);
    if (!row) continue;
    if (typeof row.agentId === "string" && row.agentId) threadId = row.agentId;
    const at = ts(row.timestamp);
    if (at) {
      if (!startedAt || at < startedAt) startedAt = at;
      if (at > lastActivityAt) lastActivityAt = at;
    }
    if (!title && (row.type === "user" || row.message?.role === "user")) {
      const content = row.message?.content;
      if (typeof content === "string") title = childTitle(content);
      else if (Array.isArray(content)) {
        title = childTitle(
          content
            .filter((block: any) => block?.type === "text")
            .map((block: any) => block.text)
            .join("\n"),
        );
      }
    }
    const spent = sumClaudeUsage(row.message?.usage);
    if (spent != null) {
      tokensSession += spent;
      tokensLastTurn = spent;
    }
  }
  try {
    const stat = statSync(path);
    startedAt ||= stat.birthtimeMs || stat.mtimeMs;
    lastActivityAt = Math.max(lastActivityAt, stat.mtimeMs);
  } catch {
    // Parsed timestamps still make this child usable.
  }
  return {
    threadId,
    parentThreadId: parentSessionId,
    title,
    depth: 1,
    state: stateFor(lastActivityAt),
    startedAt: startedAt || lastActivityAt,
    lastActivityAt,
    tokensSession,
    tokensLastTurn,
  };
}

/**
 * New tokens only: prompt, completion, and cache writes.
 *
 * `cache_read_input_tokens` is deliberately excluded — the same cached prefix is
 * re-counted on every single turn, so summing it produces a number in the
 * hundreds of millions for one long chat and tells you nothing about what the
 * work actually cost.
 */
function claudeCounters(usage: unknown): {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  hasContext: boolean;
} | undefined {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const row = usage as Record<string, unknown>;
  const keys = [
    "input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens",
  ] as const;
  if (!keys.some((key) => row[key] !== undefined)) return undefined;
  const values: number[] = [];
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) return undefined;
    values.push((value as number | undefined) ?? 0);
  }
  return {
    input: values[0]!, output: values[1]!, cacheWrite: values[2]!, cacheRead: values[3]!,
    hasContext: keys.some((key) => key !== "output_tokens" && row[key] !== undefined),
  };
}

export function sumClaudeUsage(usage: unknown): number | undefined {
  const counters = claudeCounters(usage);
  if (!counters) return undefined;
  const total = counters.input + counters.output + counters.cacheWrite;
  return Number.isSafeInteger(total) ? total : undefined;
}

export function claudeContextUsage(usage: unknown): number | undefined {
  const counters = claudeCounters(usage);
  if (!counters?.hasContext) return undefined;
  const total = counters.input + counters.cacheWrite + counters.cacheRead;
  return Number.isSafeInteger(total) ? total : undefined;
}

export function claudeLogPath(sessionId: string): string | undefined {
  const indexed = claudeLogPathBySession.get(sessionId);
  if (indexed) return indexed;
  return recentLogs(claudeProjectsRoot(), 2).find((path) =>
    path.endsWith(`/${sessionId}.jsonl`),
  );
}

export function claudeLogLines(sessionId: string): string[] | undefined {
  const file = claudeLogPath(sessionId);
  if (!file) return undefined;
  try {
    return readFileSync(file, "utf8").split("\n");
  } catch {
    return undefined;
  }
}
