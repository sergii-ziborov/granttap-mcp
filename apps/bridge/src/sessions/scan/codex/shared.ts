import { toolDescription } from "../../support/activity-helpers";
import { diffPreviewFromInput, sensitivePath, statsFromInput } from "../../support/edit-stats";
import { redactSecrets } from "../../telemetry/command-preview";
import { recordObservedWrite, writtenPaths } from "../../../mesh/observed/writes";
/**
 * Codex session logs:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *   `event_msg` entries of type `token_count` carry
 *   `total_token_usage` and `last_token_usage` outright.
 */
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  ActivityEntry,
  ChildThreadInfo,
  SessionInfo,
} from "../../../../../../packages/protocol/schema";
import {
  codexSessionsRoot,
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
  toolSummary,
  visibleUserText,
} from "../../support/activity-helpers";
import {
  aggregateChildThreads,
  childEntryFields,
  childTitle,
} from "../../support/child-threads";
import { codexHeadRequest } from "../../support/codex-head";
import {
  activityTelemetry,
  observeCapability,
  pendingCapabilityObservation,
  rememberCapabilityObservation,
  rememberPendingCapabilityCall,
  type CapabilityObservation,
  type PendingCapabilityTool,
} from "../../telemetry";

export type CachedCodexSummary = {
  mtimeMs: number;
  size: number;
  session: SessionInfo;
  tokensSession: number;
  observations: CapabilityObservation[];
  child?: CodexChildSource;
  turn?: import("./turn-state").CodexTurnClock;
};

export type CodexChildSource = {
  parentThreadId: string;
  depth: number;
  agentPath?: string;
  agentName?: string;
};

export type CodexCandidate = {
  file: string;
  session: SessionInfo;
  observations: CapabilityObservation[];
  child?: CodexChildSource;
};

export type CodexActivitySource = {
  path: string;
  child?: ChildThreadInfo;
};

export const codexSummaryCache = new Map<string, CachedCodexSummary>();
export const codexLogPathBySession = new Map<string, string>();
export const codexActivitySourcesBySession = new Map<string, CodexActivitySource[]>();
export const codexAggregatedObservationsBySession = new Map<string, CapabilityObservation[]>();

export { workdirsFromCodexCall, observedCodexWorktree } from "./repository-observation";

export function codexTranscriptPaths(sessionId: string): string[] {
  return codexActivitySourcesBySession.get(sessionId)?.map((source) => source.path)
    ?? [codexLogPathBySession.get(sessionId)].filter((path): path is string => path != null);
}

export const CODEX_SUMMARY_HEAD_BYTES = 128 * 1024;
export const CODEX_SUMMARY_TAIL_BYTES = 512 * 1024;
export const CODEX_ACTIVITY_HEAD_BYTES = 256 * 1024;
export const CODEX_ACTIVITY_TAIL_BYTES = 16 * 1024 * 1024;

/** Resolve the native rollout directly before considering a catalog-wide scan. */
export function codexLogPathForSession(sessionId: string, startedAt: number,
                                       root = codexSessionsRoot()): string | undefined {
  const indexed = codexLogPathBySession.get(sessionId);
  if (indexed) {
    try { if (lstatSync(indexed).isFile()) return indexed; } catch { /* Find its new path. */ }
    codexLogPathBySession.delete(sessionId);
  }
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(sessionId) || !Number.isFinite(startedAt)
    || startedAt <= 0) return undefined;
  const start = ts(startedAt);
  for (const dayOffset of [0, -1, 1]) {
    const day = new Date(start + dayOffset * 86_400_000);
    if (Number.isNaN(day.getTime())) continue;
    const [year, month, date] = day.toISOString().slice(0, 10).split("-");
    const directory = join(root, year!, month!, date!);
    let names: string[];
    try { names = readdirSync(directory); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith("rollout-") || !name.endsWith(`-${sessionId}.jsonl`)) continue;
      const path = join(directory, name);
      try {
        if (!lstatSync(path).isFile()) continue;
        codexLogPathBySession.set(sessionId, path);
        return path;
      } catch { /* A file may disappear during a catalog refresh. */ }
    }
  }
  return undefined;
}

/**
 * Codex rollouts may contain a single screenshot/tool-result line larger than a
 * gigabyte. A catalog refresh must never materialize that whole file. Preserve
 * complete JSONL rows from the metadata head and recent tail under a hard cap.
 */
export function readCodexLogWindow(
  path: string,
  headBytes = CODEX_SUMMARY_HEAD_BYTES,
  tailBytes = CODEX_SUMMARY_TAIL_BYTES,
): string[] {
  const size = statSync(path).size;
  if (size <= headBytes + tailBytes) return readFileSync(path, "utf8").split("\n");
  const fd = openSync(path, "r");
  try {
    const head = Buffer.allocUnsafe(headBytes);
    const headRead = readSync(fd, head, 0, headBytes, 0);
    let headText = head.subarray(0, headRead).toString("utf8");
    const headBreak = headText.lastIndexOf("\n");
    headText = headBreak >= 0 ? headText.slice(0, headBreak + 1) : "";

    const tailStart = Math.max(0, size - tailBytes - 1);
    const tailLength = size - tailStart;
    const tail = Buffer.allocUnsafe(tailLength);
    const tailRead = readSync(fd, tail, 0, tailLength, tailStart);
    let tailText = tail.subarray(0, tailRead).toString("utf8");
    if (tailStart > 0) {
      const tailBreak = tailText.indexOf("\n");
      tailText = tailBreak >= 0 ? tailText.slice(tailBreak + 1) : "";
    }
    return `${headText}${tailText}`.split("\n");
  } finally {
    closeSync(fd);
  }
}

export function codexChildSource(meta: any): CodexChildSource | undefined {
  const spawn = meta?.source?.subagent?.thread_spawn;
  const parentThreadId =
    typeof spawn?.parent_thread_id === "string" ? spawn.parent_thread_id.trim() : "";
  if (!parentThreadId) return undefined;
  return {
    parentThreadId,
    depth: Math.max(1, Math.min(16, Number(spawn.depth) || 1)),
    agentPath: typeof spawn.agent_path === "string" ? spawn.agent_path : undefined,
    agentName: typeof spawn.agent_nickname === "string" ? spawn.agent_nickname : undefined,
  };
}

/** Exclude the repeatedly-counted cached prompt from session spend. */
export function effectiveCodexUsage(usage: any): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const total = usage.total_tokens;
  if (typeof total !== "number" || !Number.isFinite(total)) return undefined;
  const cached =
    typeof usage.cached_input_tokens === "number" && Number.isFinite(usage.cached_input_tokens)
      ? usage.cached_input_tokens
      : 0;
  return Math.max(0, total - cached);
}

export function codexLogLines(sessionId: string): string[] | undefined {
  const indexed = codexLogPathBySession.get(sessionId);
  if (indexed) {
    try {
      return readCodexLogWindow(
        indexed,
        CODEX_ACTIVITY_HEAD_BYTES,
        CODEX_ACTIVITY_TAIL_BYTES,
      );
    } catch {
      codexLogPathBySession.delete(sessionId);
    }
  }
  for (const file of recentLogs(codexSessionsRoot(), 5)) {
    try {
      const candidate = readCodexLogWindow(
        file, CODEX_ACTIVITY_HEAD_BYTES, CODEX_ACTIVITY_TAIL_BYTES,
      );
      if (candidate.some((line) => {
        const row = safeParse(line);
        return row?.type === "session_meta" &&
          String(row.payload?.id ?? row.id ?? "") === sessionId;
      })) {
        codexLogPathBySession.set(sessionId, file);
        return candidate;
      }
    } catch {
      // Keep looking through the bounded recent-file set.
    }
  }
  return undefined;
}
