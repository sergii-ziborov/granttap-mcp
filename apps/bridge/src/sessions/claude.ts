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
} from "../../../../packages/protocol/schema";
import {
  claudeProjectsRoot,
  recentLogs,
  safeParse,
  stateFor,
  TOKEN_WINDOW_MS,
  ts,
  type Scan,
} from "./common";
import {
  classifyTool,
  estimateTokens,
  pushEntry,
  toolSummary,
} from "./activity-helpers";
import {
  aggregateChildThreads,
  childEntryFields,
  childTitle,
} from "./child-threads";
import {
  activityTelemetry,
  observeCapability,
  pendingCapabilityObservation,
  rememberCapabilityObservation,
  rememberPendingCapabilityCall,
  type CapabilityObservation,
  type PendingCapabilityTool,
} from "./telemetry";

type CachedClaudeSummary = {
  mtimeMs: number;
  size: number;
  childFingerprint: string;
  session: SessionInfo;
  tokensSession: number;
  observations: CapabilityObservation[];
};

const claudeSummaryCache = new Map<string, CachedClaudeSummary>();
const claudeLogPathBySession = new Map<string, string>();
const claudeChildLogPathsBySession = new Map<string, string[]>();

function claudeChildLogPaths(parentFile: string, sessionId: string): string[] {
  return recentLogs(join(dirname(parentFile), sessionId, "subagents"), 4)
    .filter((path) => basename(path).startsWith("agent-"));
}

function childLogsFingerprint(paths: string[]): string {
  return paths.map((path) => {
    try {
      const stat = statSync(path);
      return `${path}\u0000${stat.mtimeMs}\u0000${stat.size}`;
    } catch {
      return `${path}\u0000missing`;
    }
  }).join("\u0001");
}

function readLines(path: string): string[] | undefined {
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch {
    return undefined;
  }
}

function claudeChildSummary(
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
    if (spent > 0) {
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
function sumClaudeUsage(u: any): number {
  if (!u || typeof u !== "object") return 0;
  return (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}

function claudeContextUsage(usage: any): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const values = [
    usage.input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  ];
  if (!values.some((value) => typeof value === "number")) return undefined;
  return values.reduce<number>(
    (sum, value) => sum + (typeof value === "number" ? value : 0),
    0,
  );
}

export function scanClaude(): Scan {
  const root = claudeProjectsRoot();
  const sessions: SessionInfo[] = [];
  let tokensRecent = 0;
  const files = recentLogs(root, 2);
  const activeFiles = new Set(files);
  const seenSessionIds = new Set<string>();
  claudeLogPathBySession.clear();
  claudeChildLogPathsBySession.clear();

  for (const file of files) {
    let fileStat;
    try {
      fileStat = statSync(file);
    } catch {
      continue;
    }
    const cached = claudeSummaryCache.get(file);
    const cachedSessionId = cached?.session.sessionId ?? basename(file, ".jsonl");
    const childPaths = claudeChildLogPaths(file, cachedSessionId);
    const childFingerprint = childLogsFingerprint(childPaths);
    if (
      cached &&
      cached.mtimeMs === fileStat.mtimeMs &&
      cached.size === fileStat.size &&
      cached.childFingerprint === childFingerprint
    ) {
      const session = {
        ...cached.session,
        state:
          cached.session.childThreads?.some((child) => stateFor(child.lastActivityAt) === "working")
            ? "working" as const
            : stateFor(cached.session.lastActivityAt),
        childThreads: cached.session.childThreads?.map((child) => ({
          ...child,
          state: stateFor(child.lastActivityAt),
        })),
      };
      if (seenSessionIds.has(session.sessionId)) continue;
      seenSessionIds.add(session.sessionId);
      sessions.push(session);
      claudeLogPathBySession.set(session.sessionId, file);
      claudeChildLogPathsBySession.set(session.sessionId, childPaths);
      if (Date.now() - session.lastActivityAt <= TOKEN_WINDOW_MS) {
        tokensRecent += cached.tokensSession;
      }
      continue;
    }
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const lines = text.split("\n");
    let sessionId = "";
    let cwd: string | undefined;
    let branch: string | undefined;
    let model: string | undefined;
    let title: string | undefined;
    let summary: string | undefined;
    let startedAt = 0;
    let lastActivityAt = 0;
    let tokensSession = 0;
    let tokensLastTurn = 0;
    let contextTokensUsed: number | undefined;

    for (const line of lines) {
      if (!line) continue;
      const d = safeParse(line);
      if (!d) continue;

      if (d.sessionId && !sessionId) sessionId = String(d.sessionId);
      if (d.cwd && !cwd) cwd = String(d.cwd);
      if (d.gitBranch && !branch) branch = String(d.gitBranch);
      if (d.type === "ai-title" && typeof d.content === "string" && !title) title = d.content;
      // Conversation title for the phone row — never fall back to project folder
      // alone (that is the list section header). Prefer ai-title, else first user text.
      if (!title && (d.type === "user" || d.message?.role === "user")) {
        const raw =
          typeof d.message?.content === "string"
            ? d.message.content
            : Array.isArray(d.message?.content)
              ? d.message.content
                  .filter((b: any) => b?.type === "text" && typeof b.text === "string")
                  .map((b: any) => b.text)
                  .join("\n")
              : typeof d.content === "string"
                ? d.content
                : "";
        const clean = String(raw).replace(/\s+/g, " ").trim();
        if (clean) title = clean.slice(0, 120);
      }

      const t = ts(d.timestamp);
      if (t) {
        if (!startedAt || t < startedAt) startedAt = t;
        if (t > lastActivityAt) lastActivityAt = t;
      }

      const usage = d?.message?.usage;
      if (usage) {
        const spent = sumClaudeUsage(usage);
        tokensSession += spent;
        tokensLastTurn = spent; // last one wins
        contextTokensUsed = claudeContextUsage(usage) ?? contextTokensUsed;
        if (d.message?.model && !model) model = String(d.message.model);
      }
      if (d.message?.role === "assistant") {
        const content = d.message.content;
        if (typeof content === "string" && content.trim()) {
          summary = childTitle(content)?.slice(0, 180);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
              summary = childTitle(block.text)?.slice(0, 180);
            }
          }
        }
      }
    }

    if (!sessionId || !lastActivityAt) continue;
    const ownSession: SessionInfo = {
      sessionId,
      agent: "claude",
      title,
      cwd,
      branch,
      model,
      summary,
      state: stateFor(lastActivityAt),
      startedAt: startedAt || lastActivityAt,
      lastActivityAt,
      tokensSession,
      tokensLastTurn,
      contextTokensUsed,
    };
    const actualChildPaths =
      sessionId === cachedSessionId ? childPaths : claudeChildLogPaths(file, sessionId);
    const childThreads: ChildThreadInfo[] = [];
    const observations = claudeCapabilityUsage(ownSession, lines);
    for (const childPath of actualChildPaths) {
      const childLines = readLines(childPath);
      if (!childLines) continue;
      const child = claudeChildSummary(childPath, sessionId, childLines);
      childThreads.push(child);
      for (const observation of claudeCapabilityUsage(ownSession, childLines, child.threadId)) {
        rememberCapabilityObservation(observations, observation);
      }
    }
    const session = aggregateChildThreads(ownSession, childThreads);
    claudeSummaryCache.set(file, {
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
      childFingerprint: childLogsFingerprint(actualChildPaths),
      session,
      tokensSession: session.tokensSession,
      observations,
    });
    if (seenSessionIds.has(sessionId)) continue;
    seenSessionIds.add(sessionId);
    claudeLogPathBySession.set(sessionId, file);
    claudeChildLogPathsBySession.set(sessionId, actualChildPaths);
    if (Date.now() - session.lastActivityAt <= TOKEN_WINDOW_MS) {
      tokensRecent += session.tokensSession;
    }
    sessions.push(session);
  }
  for (const file of claudeSummaryCache.keys()) {
    if (!activeFiles.has(file)) claudeSummaryCache.delete(file);
  }
  return { sessions, tokensRecent };
}

function claudeLogPath(sessionId: string): string | undefined {
  const indexed = claudeLogPathBySession.get(sessionId);
  if (indexed) return indexed;
  return recentLogs(claudeProjectsRoot(), 2).find((path) =>
    path.endsWith(`/${sessionId}.jsonl`),
  );
}

function claudeLogLines(sessionId: string): string[] | undefined {
  const file = claudeLogPath(sessionId);
  if (!file) return undefined;
  try {
    return readFileSync(file, "utf8").split("\n");
  } catch {
    return undefined;
  }
}

function cachedClaudeCapabilityUsage(
  sessionId: string,
): CapabilityObservation[] | undefined {
  const file = claudeLogPathBySession.get(sessionId);
  if (!file) return undefined;
  const cached = claudeSummaryCache.get(file);
  if (!cached || cached.session.sessionId !== sessionId) return undefined;
  try {
    const stat = statSync(file);
    if (stat.mtimeMs !== cached.mtimeMs || stat.size !== cached.size) return undefined;
    const childPaths = claudeChildLogPathsBySession.get(sessionId) ?? [];
    if (childLogsFingerprint(childPaths) !== cached.childFingerprint) return undefined;
  } catch {
    return undefined;
  }
  return cached.observations;
}

/** Pair Claude tool_use/tool_result rows without exposing result contents. */
export function claudeCapabilityUsage(
  session: SessionInfo,
  lines?: string[],
  sourceThreadId = session.sessionId,
): CapabilityObservation[] {
  if (!lines) {
    const cached = cachedClaudeCapabilityUsage(session.sessionId);
    if (cached) return cached;
    lines = claudeLogLines(session.sessionId);
  }
  if (!lines) return [];
  const pending = new Map<string, PendingCapabilityTool>();
  const out: CapabilityObservation[] = [];

  for (const line of lines) {
    const row = safeParse(line);
    if (!row || !Array.isArray(row.message?.content)) continue;
    const rowAt = ts(row.timestamp);
    for (const block of row.message.content as any[]) {
      if (
        block?.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        const item: PendingCapabilityTool = {
          sourceId: `${sourceThreadId}:${block.id}`,
          sessionId: session.sessionId,
          toolName: block.name,
          input: block.input,
          createdAt: rowAt || session.lastActivityAt,
          cwd: session.cwd ?? undefined,
        };
        if (pendingCapabilityObservation(item)) {
          rememberPendingCapabilityCall(pending, block.id, item);
        }
        continue;
      }
      if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") {
        continue;
      }
      const item = pending.get(block.tool_use_id);
      if (!item) continue;
      const observation =
        observeCapability(item, block.content, rowAt || item.createdAt, {
          outcome: block.is_error === true ? "error" : "success",
          errorClass: block.is_error === true ? "tool_result" : undefined,
        }, "claude") ??
        pendingCapabilityObservation(item);
      if (observation) rememberCapabilityObservation(out, observation);
      pending.delete(block.tool_use_id);
    }
  }

  for (const item of pending.values()) {
    const observation = pendingCapabilityObservation(item);
    if (observation) rememberCapabilityObservation(out, observation);
  }
  return out;
}

function appendClaudeActivity(
  out: ActivityEntry[],
  seen: Set<string>,
  session: SessionInfo,
  lines: string[],
  observations: Map<string, CapabilityObservation>,
  child?: ChildThreadInfo,
): void {
  const sourceThreadId = child?.threadId ?? session.sessionId;
  const childFields = child ? childEntryFields(child) : {};
  lines.forEach((line, index) => {
    const d = safeParse(line);
    if (!d) return;
    const createdAt = ts(d.timestamp) || session.lastActivityAt;
    const content = d.message?.content;
    if (d.type === "user" || d.message?.role === "user") {
      if (typeof content === "string") {
        pushEntry(out, seen, session.sessionId, "user", content, createdAt, index, childFields);
      } else if (Array.isArray(content)) {
        content.forEach((block: any, blockIndex: number) => {
          // Tool results and system/reminder blocks are transport context, not
          // words the person typed. Only explicit visible text belongs in chat.
          if (block?.type === "text") {
            pushEntry(
              out,
              seen,
              session.sessionId,
              "user",
              block.text,
              createdAt,
              index * 100 + blockIndex,
              childFields,
            );
          }
        });
      }
      return;
    }
    if (d.type !== "assistant" && d.message?.role !== "assistant") return;
    if (typeof content === "string") {
      pushEntry(out, seen, session.sessionId, "message", content, createdAt, index, childFields);
      return;
    }
    if (!Array.isArray(content)) return;
    content.forEach((block: any, blockIndex: number) => {
      if (block?.type === "text") {
        pushEntry(
          out,
          seen,
          session.sessionId,
          "message",
          block.text,
          createdAt,
          index * 100 + blockIndex,
          childFields,
        );
      } else if (block?.type === "tool_use") {
        const classified = classifyTool(block.name, block.input);
        const sourceId =
          typeof block.id === "string"
            ? `${sourceThreadId}:${block.id}`
            : `${sourceThreadId}:${createdAt}:${index * 100 + blockIndex}`;
        const pending: PendingCapabilityTool = {
          sourceId,
          sessionId: session.sessionId,
          toolName: String(block.name ?? "tool"),
          input: block.input,
          createdAt,
          cwd: session.cwd ?? undefined,
        };
        const observation =
          observations.get(sourceId) ?? pendingCapabilityObservation(pending);
        pushEntry(
          out,
          seen,
          session.sessionId,
          "tool",
          toolSummary(block.name, block.input),
          createdAt,
          index * 100 + blockIndex,
          {
            ...childFields,
            ...classified,
            ...(observation
              ? activityTelemetry(observation)
              : { estimatedContextTokens: estimateTokens(block.input) }),
          },
          observation ? sourceId : undefined,
        );
      }
    });
  });
}

export function claudeActivity(session: SessionInfo): ActivityEntry[] {
  const lines = claudeLogLines(session.sessionId);
  if (!lines) return [];
  const observations = new Map(
    claudeCapabilityUsage(session).map((item) => [item.sourceId, item]),
  );
  const out: ActivityEntry[] = [];
  const seen = new Set<string>();
  appendClaudeActivity(out, seen, session, lines, observations);
  const childById = new Map(session.childThreads?.map((child) => [child.threadId, child]));
  for (const path of claudeChildLogPathsBySession.get(session.sessionId) ?? []) {
    const childLines = readLines(path);
    if (!childLines) continue;
    const inferred = claudeChildSummary(path, session.sessionId, childLines);
    const child = childById.get(inferred.threadId) ?? inferred;
    appendClaudeActivity(out, seen, session, childLines, observations, child);
  }
  // V8 sort is stable: preserve transcript order when a provider stamps a
  // whole batch with the same millisecond. Source ids are not chronological.
  return out.sort((a, b) => a.createdAt - b.createdAt);
}
