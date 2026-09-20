import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { ChildThreadInfo, SessionInfo } from "../../../../../../packages/protocol/schema";
import { aggregateChildThreads, childTitle } from "../../support/child-threads";
import { rememberCapabilityObservation } from "../../telemetry";
import { safeParse, stateFor, ts } from "../../support/common";
import { claudeCapabilityUsage } from "./activity";
import {
  childLogsFingerprint,
  claudeChildLogPaths,
  claudeChildSummary,
  claudeContextUsage,
  claudeSummaryCache,
  readLines,
  sumClaudeUsage,
} from "./shared";

type ClaudeParseState = {
  sessionId: string;
  cwd?: string;
  branch?: string;
  model?: string;
  title?: string;
  summary?: string;
  startedAt: number;
  lastActivityAt: number;
  tokensSession: number;
  tokensLastTurn: number;
  contextTokensUsed?: number;
};

function applyClaudeLine(d: any, state: ClaudeParseState): void {
  if (d.sessionId && !state.sessionId) state.sessionId = String(d.sessionId);
  if (d.cwd && !state.cwd) state.cwd = String(d.cwd);
  if (d.gitBranch && !state.branch) state.branch = String(d.gitBranch);
  if (d.type === "ai-title" && typeof d.content === "string" && !state.title) state.title = d.content;
  if (!state.title && (d.type === "user" || d.message?.role === "user")) {
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
    if (clean) state.title = clean.slice(0, 120);
  }
  const t = ts(d.timestamp);
  if (t) {
    if (!state.startedAt || t < state.startedAt) state.startedAt = t;
    if (t > state.lastActivityAt) state.lastActivityAt = t;
  }
  const usage = d?.message?.usage;
  if (usage) {
    const spent = sumClaudeUsage(usage);
    state.tokensSession += spent;
    state.tokensLastTurn = spent;
    state.contextTokensUsed = claudeContextUsage(usage) ?? state.contextTokensUsed;
    if (d.message?.model && !state.model) state.model = String(d.message.model);
  }
  if (d.message?.role === "assistant") {
    const content = d.message.content;
    if (typeof content === "string" && content.trim()) {
      state.summary = childTitle(content)?.slice(0, 180);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          state.summary = childTitle(block.text)?.slice(0, 180);
        }
      }
    }
  }
}

export function parseClaudeFile(file: string): {
  session: SessionInfo;
  tokensSession: number;
  childPaths: string[];
} | undefined {
  let fileStat;
  try {
    fileStat = statSync(file);
  } catch {
    return undefined;
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
    return { session, tokensSession: cached.tokensSession, childPaths };
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const lines = text.split("\n");
  const state: ClaudeParseState = { sessionId: "", startedAt: 0, lastActivityAt: 0, tokensSession: 0, tokensLastTurn: 0 };
  for (const line of lines) {
    if (!line) continue;
    const d = safeParse(line);
    if (d) applyClaudeLine(d, state);
  }
  if (!state.sessionId || !state.lastActivityAt) return undefined;
  const ownSession: SessionInfo = {
    sessionId: state.sessionId,
    agent: "claude",
    title: state.title,
    cwd: state.cwd,
    branch: state.branch,
    model: state.model,
    summary: state.summary,
    state: stateFor(state.lastActivityAt),
    startedAt: state.startedAt || state.lastActivityAt,
    lastActivityAt: state.lastActivityAt,
    tokensSession: state.tokensSession,
    tokensLastTurn: state.tokensLastTurn,
    contextTokensUsed: state.contextTokensUsed,
  };
  const actualChildPaths =
    state.sessionId === cachedSessionId ? childPaths : claudeChildLogPaths(file, state.sessionId);
  const childThreads: ChildThreadInfo[] = [];
  const observations = claudeCapabilityUsage(ownSession, lines);
  for (const childPath of actualChildPaths) {
    const childLines = readLines(childPath);
    if (!childLines) continue;
    const child = claudeChildSummary(childPath, state.sessionId, childLines);
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
  return { session, tokensSession: session.tokensSession, childPaths: actualChildPaths };
}
