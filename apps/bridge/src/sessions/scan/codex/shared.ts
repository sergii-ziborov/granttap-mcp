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
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
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

function gitRoot(path: string): string | undefined {
  try {
    return execFileSync("git", ["-C", path, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000,
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function below(parent: string, path: string): boolean {
  const suffix = relative(parent, path);
  return Boolean(suffix) && !suffix.startsWith("..") && !isAbsolute(suffix);
}

/** Structured assistant tool calls can reveal a checkout when Codex started in its parent folder. */
export function workdirsFromCodexCall(line: unknown): string[] {
  if (!line || typeof line !== "object") return [];
  const record = line as { type?: string; payload?: { type?: string; name?: string; input?: string } };
  const payload = record.payload;
  if (record.type !== "response_item" || payload?.type !== "custom_tool_call"
      || payload.name !== "exec" || typeof payload.input !== "string") return [];
  return [...payload.input.matchAll(/\bworkdir\s*:\s*(["'])(\/[^"'\r\n]+)\1/g)]
    .map((match) => match[2]!);
}

/** A parent workspace is not a repository; reject one-off or ambiguous cross-repo references. */
export function observedCodexWorktree(cwd: string, workdirs: string[]): string | undefined {
  if (workdirs.length < 3 || gitRoot(cwd)) return undefined;
  let base: string;
  try { base = realpathSync(cwd); } catch { return undefined; }
  const counts = new Map<string, number>();
  const roots = new Map<string, string | undefined>();
  let relevant = 0;
  for (const path of workdirs) {
    let resolved: string;
    try { resolved = realpathSync(path); } catch { continue; }
    if (!below(base, resolved)) continue;
    relevant += 1;
    if (!roots.has(resolved)) roots.set(resolved, gitRoot(resolved));
    const root = roots.get(resolved);
    if (!root || !below(base, root)) continue;
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  if (counts.size !== 1 || relevant < 3) return undefined;
  const [root, count] = [...counts][0]!;
  return count >= 3 && count / relevant >= 0.8 ? root : undefined;
}

export function codexTranscriptPaths(sessionId: string): string[] {
  return codexActivitySourcesBySession.get(sessionId)?.map((source) => source.path)
    ?? [codexLogPathBySession.get(sessionId)].filter((path): path is string => path != null);
}

export const CODEX_SUMMARY_HEAD_BYTES = 128 * 1024;
export const CODEX_SUMMARY_TAIL_BYTES = 512 * 1024;
export const CODEX_ACTIVITY_HEAD_BYTES = 256 * 1024;
export const CODEX_ACTIVITY_TAIL_BYTES = 2 * 1024 * 1024;

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
