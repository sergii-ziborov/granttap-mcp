import { readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { normalizeMcpServerName } from "../activity-helpers";
import { cursorTranscriptsRoot, recentLogs, safeParse, ts } from "../common";
import {
  estimateTokens,
  observeCapability,
  pendingCapabilityObservation,
  rememberCapabilityObservation,
  rememberPendingCapabilityCall,
  type CapabilityObservation,
  type PendingCapabilityTool,
} from "../telemetry";

export type CursorLogFile = {
  path: string;
  mtimeMs: number;
  birthtimeMs: number;
  size: number;
  isSubagent: boolean;
  ownerSessionId?: string;
  threadId?: string;
};

export type CursorTranscriptSummary = {
  lastActivityAt: number;
  startedAt: number;
  files: string[];
  model?: string;
  titleFromUser?: string;
  tokensSession: number;
  tokensLastTurn: number;
  contextTokensUsed: number;
  observations: CapabilityObservation[];
};

export function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text);
}

function titleFrom(text: string): string | undefined {
  const query = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i)?.[1] ?? text;
  const clean = query.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 120) : undefined;
}

export function isParentConversationFile(file: string): boolean {
  if (file.includes("/subagents/")) return false;
  return basename(file, ".jsonl") === basename(dirname(file));
}

function cursorLogFile(path: string): CursorLogFile | undefined {
  try {
    const stat = statSync(path);
    const isSubagent = path.includes("/subagents/");
    const ownerSessionId = isSubagent
      ? basename(dirname(dirname(path)))
      : isParentConversationFile(path) ? basename(path, ".jsonl") : undefined;
    return {
      path,
      mtimeMs: stat.mtimeMs,
      birthtimeMs: stat.birthtimeMs,
      size: stat.size,
      isSubagent,
      ownerSessionId,
      threadId: isSubagent ? basename(path, ".jsonl") : ownerSessionId,
    };
  } catch {
    return undefined;
  }
}

const CURSOR_LOG_INDEX_CACHE_MS = 1_000;
let snapshotCache: { root: string; walkedAt: number; files: CursorLogFile[] } | undefined;

export function cursorLogSnapshot(): CursorLogFile[] {
  const root = cursorTranscriptsRoot();
  const now = Date.now();
  if (snapshotCache?.root === root && now - snapshotCache.walkedAt < CURSOR_LOG_INDEX_CACHE_MS) {
    const files = snapshotCache.files.map((file) => cursorLogFile(file.path))
      .filter((file): file is CursorLogFile => file != null);
    snapshotCache = { root, walkedAt: snapshotCache.walkedAt, files };
    return files;
  }
  const files = recentLogs(root, 6).map(cursorLogFile)
    .filter((file): file is CursorLogFile => file != null);
  snapshotCache = { root, walkedAt: now, files };
  return files;
}

export function conversationIndex(files: CursorLogFile[]): Map<string, CursorLogFile[]> {
  const index = new Map<string, CursorLogFile[]>();
  for (const file of files) {
    if (!file.ownerSessionId) continue;
    const current = index.get(file.ownerSessionId) ?? [];
    current.push(file);
    index.set(file.ownerSessionId, current);
  }
  for (const values of index.values()) {
    values.sort((a, b) => a.isSubagent === b.isSubagent
      ? a.mtimeMs - b.mtimeMs
      : a.isSubagent ? 1 : -1);
  }
  return index;
}

export function workspaceLabel(file: string): string | undefined {
  const parts = file.split("/");
  const index = parts.lastIndexOf("projects");
  return index >= 0 ? parts[index + 1] : undefined;
}

type SummaryAccumulator = CursorTranscriptSummary & {
  lastRole?: string;
  pending: Map<string, PendingCapabilityTool>;
};

function observeBlocks(
  item: any,
  file: CursorLogFile,
  lineIndex: number,
  rootSessionId: string,
  cwd: string | undefined,
  acc: SummaryAccumulator,
): void {
  const content = item.message?.content;
  if (!Array.isArray(content)) return;
  const sourceThreadId = file.threadId ?? rootSessionId;
  const rowAt = ts(item.timestamp) || file.mtimeMs;
  for (const [blockIndex, block] of content.entries()) {
    if (block?.type === "tool_use" && typeof block.name === "string") {
      const callId = typeof block.id === "string" && block.id
        ? block.id
        : `${basename(file.path, ".jsonl")}:${lineIndex}:${blockIndex}`;
      const key = `${sourceThreadId}\u0000${callId}`;
      const input = block.input;
      let toolName = block.name;
      if (/^(CallMcpTool|GetMcpTools)$/i.test(toolName) && input && typeof input === "object") {
        const meta = input as Record<string, unknown>;
        const server = typeof meta.server === "string" ? normalizeMcpServerName(meta.server) : "";
        const inner = typeof meta.toolName === "string" && meta.toolName.trim()
          ? meta.toolName.trim()
          : toolName;
        if (server) toolName = `mcp__${server}__${inner}`;
      }
      const pending: PendingCapabilityTool = {
        sourceId: `${sourceThreadId}:${callId}`,
        sessionId: rootSessionId,
        toolName,
        input,
        createdAt: rowAt,
        cwd,
      };
      if (pendingCapabilityObservation(pending)) {
        rememberPendingCapabilityCall(acc.pending, key, pending);
      }
    } else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
      const key = `${sourceThreadId}\u0000${block.tool_use_id}`;
      const pending = acc.pending.get(key);
      if (!pending) continue;
      const observation = observeCapability(pending, block.content, rowAt, {
        outcome: block.is_error === true ? "error" : "success",
        errorClass: block.is_error === true ? "tool_result" : undefined,
      })
        ?? pendingCapabilityObservation(pending);
      if (observation) rememberCapabilityObservation(acc.observations, observation);
      acc.pending.delete(key);
    }
  }
}

function summarizeFile(
  file: CursorLogFile,
  rootSessionId: string,
  cwd: string | undefined,
  acc: SummaryAccumulator,
): void {
  acc.lastActivityAt = Math.max(acc.lastActivityAt, file.mtimeMs);
  const birth = file.birthtimeMs || file.mtimeMs;
  if (!acc.startedAt || birth < acc.startedAt) acc.startedAt = birth;
  let lines: string[];
  try {
    lines = readFileSync(file.path, "utf8").split("\n");
  } catch {
    return;
  }
  for (const [lineIndex, line] of lines.entries()) {
    const item = safeParse(line);
    if (!item) continue;
    observeBlocks(item, file, lineIndex, rootSessionId, cwd, acc);
    if (!file.isSubagent) {
      if (!acc.titleFromUser && item.role === "user") {
        acc.titleFromUser = titleFrom(textBlocks(item.message?.content).join("\n"));
      }
      const candidate = item.message?.model ?? item.model;
      if (typeof candidate === "string") acc.model = candidate;
    }
    if (!item.role) continue;
    const text = textBlocks(item.message?.content).join("\n");
    const usage = item.message?.usage ?? item.usage;
    let spent = usage && typeof usage === "object"
      ? Number(usage.input_tokens ?? usage.inputTokens ?? 0)
        + Number(usage.output_tokens ?? usage.outputTokens ?? 0)
        + Number(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? 0)
      : 0;
    if (!spent && text) spent = estimateTokens(text);
    if (!spent) continue;
    acc.tokensSession += spent;
    if (item.role === "assistant" || acc.lastRole === "user") acc.tokensLastTurn = spent;
    acc.lastRole = item.role;
  }
}

const summaryCache = new Map<string, { fingerprint: string; summary: CursorTranscriptSummary }>();

export function transcriptSummary(
  cacheKey: string,
  files: CursorLogFile[],
  rootSessionId = cacheKey,
  cwd?: string,
): CursorTranscriptSummary {
  const fingerprint = files.map((file) => `${file.path}\u0000${file.mtimeMs}\u0000${file.size}`)
    .join("\u0001") + `\u0002${rootSessionId}\u0002${cwd ?? ""}`;
  const cached = summaryCache.get(cacheKey);
  if (cached?.fingerprint === fingerprint) return cached.summary;
  const acc: SummaryAccumulator = {
    lastActivityAt: 0, startedAt: 0, files: files.map((file) => file.path),
    tokensSession: 0, tokensLastTurn: 0, contextTokensUsed: 0,
    observations: [], pending: new Map(),
  };
  for (const file of files) summarizeFile(file, rootSessionId, cwd, acc);
  for (const pending of acc.pending.values()) {
    const observation = pendingCapabilityObservation(pending);
    if (observation) rememberCapabilityObservation(acc.observations, observation);
  }
  const { pending, lastRole, ...summary } = acc;
  summary.contextTokensUsed = summary.tokensSession;
  summaryCache.delete(cacheKey);
  summaryCache.set(cacheKey, { fingerprint, summary });
  while (summaryCache.size > 512) summaryCache.delete(summaryCache.keys().next().value!);
  return summary;
}

export function mergeCapabilityUsage(
  summaries: CursorTranscriptSummary[],
): CapabilityObservation[] {
  const out: CapabilityObservation[] = [];
  for (const summary of summaries) {
    for (const observation of summary.observations) {
      rememberCapabilityObservation(out, observation);
    }
  }
  return out;
}
