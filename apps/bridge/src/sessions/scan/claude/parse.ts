import { closeSync, openSync, readSync, statSync } from "node:fs";
import { mergeRecordedClaudeUsage, recordedClaudeUsageIsCurrent } from './recorded-usage';
import { basename } from "node:path";
import type { ChildThreadInfo, SessionInfo } from "../../../../../../packages/protocol/schema";
import { aggregateChildThreads, childTitle } from "../../support/child-threads";
import { rememberCapabilityObservation } from "../../telemetry";
import { observeClaudeTurn } from "./turn-state";
import { LIVE_MS, safeParse, stateFor, ts } from "../../support/common";
import { finishScan } from "../../cooperative-scan";
import { claudeCapabilityUsage, createClaudeCapabilityCollector } from "./activity";
import { pastedImageLabel } from "../../support/activity-helpers";
import { claudeRepositoryPaths } from "./repository-observation";
import { observedCheckoutRoot } from "../../support/repository-checkout";
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
  lastMessageAt: number;
  tokensSession: number;
  tokensLastTurn: number;
  contextTokensUsed?: number;
  repositoryPaths: string[];
  turnEnded: boolean;
};

function applyClaudeLine(d: any, state: ClaudeParseState): void {
  observeClaudeTurn(d, state);
  if (d.isSidechain !== true) state.repositoryPaths.push(...claudeRepositoryPaths(d));
  state.repositoryPaths = state.repositoryPaths.slice(-64);
  if (d.sessionId && !state.sessionId) state.sessionId = String(d.sessionId);
  if (d.isSidechain !== true) {
    if (typeof d.cwd === "string" && d.cwd.trim()) state.cwd = d.cwd;
    if (typeof d.gitBranch === "string" && d.gitBranch.trim()) state.branch = d.gitBranch;
  }
  if (d.type === "ai-title" && typeof d.content === "string" && !state.title) state.title = d.content;
  if (!state.title && (d.type === "user" || d.message?.role === "user")) {
    const raw =
      typeof d.message?.content === "string"
        ? d.message.content
        : Array.isArray(d.message?.content)
          ? d.message.content
              .filter((b: any) => b?.type === "text" && typeof b.text === "string"
                && !pastedImageLabel(b, d.message.content))
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
    const role = d.message?.role ?? d.type;
    const content = d.message?.content ?? d.content;
    const visible = typeof content === "string" ? content.trim().length > 0
      : Array.isArray(content) && content.some((block: any) =>
        ["text", "image", "image_url", "input_image"].includes(block?.type)
          && (block.type !== "text" || typeof block.text === "string" && !!block.text.trim()));
    if (["user", "assistant"].includes(role) && visible) {
      state.lastMessageAt = Math.max(state.lastMessageAt, t);
    }
  }
  const usage = d?.message?.usage;
  if (usage) {
    const spent = sumClaudeUsage(usage);
    if (spent != null) {
      state.tokensSession += spent;
      state.tokensLastTurn = spent;
    }
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

type ClaudeParseResult = { session: SessionInfo; tokensSession: number; childPaths: string[] } | undefined;

/** What was already read from one growing transcript. It holds summaries, never message text. */
export type ClaudeParseProgress = {
  device: number;
  inode: number;
  offset: number;
  /** The bytes before `offset`: a rewritten log must not be continued as if it had only grown. */
  tail: Buffer;
  state: ClaudeParseState;
  capabilities: ReturnType<typeof createClaudeCapabilityCollector>;
  children: Map<string, { fingerprint: string; summary: ChildThreadInfo; observations: ReturnType<typeof claudeCapabilityUsage> }>;
};

const READ_CHUNK_BYTES = 1024 * 1024;
const TAIL_BYTES = 256;

function newProgress(device: number, inode: number, fallbackSessionId: string): ClaudeParseProgress {
  const state: ClaudeParseState = {
    sessionId: "", startedAt: 0, lastActivityAt: 0, lastMessageAt: 0,
    tokensSession: 0, tokensLastTurn: 0, repositoryPaths: [], turnEnded: false,
  };
  return { device, inode, offset: 0, tail: Buffer.alloc(0), state, children: new Map(),
    capabilities: createClaudeCapabilityCollector(() => ({ sessionId: state.sessionId || fallbackSessionId,
      lastActivityAt: state.lastActivityAt, cwd: state.cwd })) };
}

function continues(progress: ClaudeParseProgress | undefined, fd: number,
  stat: { dev: number; ino: number; size: number }): progress is ClaudeParseProgress {
  if (!progress || progress.device !== stat.dev || progress.inode !== stat.ino || stat.size < progress.offset) return false;
  const tail = Buffer.alloc(progress.tail.length);
  return readSync(fd, tail, 0, tail.length, progress.offset - tail.length) === tail.length && tail.equals(progress.tail);
}

function applyRow(line: string, progress: ClaudeParseProgress): boolean {
  const row = line ? safeParse(line) : null;
  if (!row) return false;
  applyClaudeLine(row, progress.state);
  progress.capabilities.add(row);
  return true;
}

/** Reads only what was appended, in slices, so one long chat cannot hold the event loop. */
function* readAppended(fd: number, progress: ClaudeParseProgress, size: number): Generator<void> {
  let carry = Buffer.alloc(0);
  while (progress.offset + carry.length < size) {
    const wanted = Math.min(READ_CHUNK_BYTES, size - progress.offset - carry.length);
    const chunk = Buffer.allocUnsafe(wanted);
    const count = readSync(fd, chunk, 0, wanted, progress.offset + carry.length);
    if (count === 0) break;
    const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, count)]) : chunk.subarray(0, count);
    const end = data.lastIndexOf(0x0a);
    if (end < 0) { carry = data; continue; }
    for (const line of data.toString("utf8", 0, end).split("\n")) applyRow(line, progress);
    progress.offset += end + 1;
    progress.tail = Buffer.from(data.subarray(Math.max(0, end + 1 - TAIL_BYTES), end + 1));
    carry = data.subarray(end + 1);
    yield;
  }
  // A complete last row without its newline counts; a row still being written waits.
  if (carry.length && applyRow(carry.toString("utf8"), progress)) {
    progress.offset += carry.length;
    progress.tail = Buffer.from(carry.subarray(Math.max(0, carry.length - TAIL_BYTES)));
  }
}

/** A subagent log is read again only when it changed, not whenever its parent chat did. */
function readChildren(paths: string[], ownSession: SessionInfo, progress: ClaudeParseProgress,
  observations: ReturnType<typeof claudeCapabilityUsage>): ChildThreadInfo[] {
  const childThreads: ChildThreadInfo[] = [];
  for (const childPath of paths) {
    const fingerprint = childLogsFingerprint([childPath]);
    let known = progress.children.get(childPath);
    if (known?.fingerprint !== fingerprint || !recordedClaudeUsageIsCurrent(known.observations)) {
      const childLines = readLines(childPath);
      if (!childLines) continue;
      const child = claudeChildSummary(childPath, ownSession.sessionId, childLines);
      known = { fingerprint, summary: child, observations: claudeCapabilityUsage(ownSession, childLines, child.threadId) };
      progress.children.set(childPath, known);
    }
    childThreads.push(known.summary);
    for (const observation of known.observations) {
      rememberCapabilityObservation(observations, observation);
    }
    mergeRecordedClaudeUsage(observations, known.observations);
  }
  return childThreads;
}

export function parseClaudeFile(file: string): ClaudeParseResult {
  return finishScan(parseClaudeFileSteps(file));
}

export function* parseClaudeFileSteps(file: string): Generator<void, ClaudeParseResult> {
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
    cached.childFingerprint === childFingerprint &&
    recordedClaudeUsageIsCurrent(cached.observations)
  ) {
    const session = {
      ...cached.session,
      state:
        cached.session.childThreads?.some((child) => stateFor(child.lastActivityAt) === "working")
          ? "working" as const
          : cached.turnEnded ? "idle" as const : stateFor(cached.session.lastActivityAt),
      childThreads: cached.session.childThreads?.map((child) => ({
        ...child,
        state: stateFor(child.lastActivityAt),
      })),
    };
    return { session, tokensSession: cached.tokensSession, childPaths };
  }
  // Taken out of the cache while in use: a parallel reader starts its own pass
  // instead of applying the same rows to this one between our slices.
  const resumable = cached?.progress as ClaudeParseProgress | undefined;
  if (cached) cached.progress = undefined;
  let progress: ClaudeParseProgress;
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return undefined;
  }
  try {
    progress = continues(resumable, fd, fileStat) ? resumable
      : newProgress(fileStat.dev, fileStat.ino, basename(file, ".jsonl"));
    yield* readAppended(fd, progress, fileStat.size);
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
  const state = progress.state;
  if (!state.sessionId || !state.lastActivityAt) return undefined;
  const ownSession: SessionInfo = {
    sessionId: state.sessionId,
    agent: "claude",
    title: state.title,
    cwd: state.cwd,
    worktree: state.cwd ? observedCheckoutRoot(state.cwd, state.repositoryPaths) : undefined,
    branch: state.branch,
    model: state.model,
    summary: state.summary,
    state: state.turnEnded ? "idle" : stateFor(state.lastActivityAt),
    startedAt: state.startedAt || state.lastActivityAt,
    lastActivityAt: state.lastActivityAt,
    ...(state.lastMessageAt ? { lastMessageAt: state.lastMessageAt } : {}),
    tokensSession: state.tokensSession,
    tokensLastTurn: state.tokensLastTurn,
    contextTokensUsed: state.contextTokensUsed,
  };
  const actualChildPaths =
    state.sessionId === cachedSessionId ? childPaths : claudeChildLogPaths(file, state.sessionId);
  const observations = progress.capabilities.snapshot();
  const childThreads = readChildren(actualChildPaths, ownSession, progress, observations);
  const session = aggregateChildThreads(ownSession, childThreads);
  claudeSummaryCache.set(file, {
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    childFingerprint: childLogsFingerprint(actualChildPaths),
    session,
    tokensSession: session.tokensSession,
    observations,
    turnEnded: state.turnEnded,
    // A chat that has gone quiet gives its memory back and is read again if it returns.
    progress: Date.now() - state.lastActivityAt <= LIVE_MS ? progress : undefined,
  });
  return { session, tokensSession: session.tokensSession, childPaths: actualChildPaths };
}
