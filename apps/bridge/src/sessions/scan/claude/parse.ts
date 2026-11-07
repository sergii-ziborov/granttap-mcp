import { closeSync, openSync, readSync, statSync } from "node:fs";
import { mergeRecordedClaudeUsage, recordedClaudeUsageIsCurrent } from './recorded-usage';
import { basename } from "node:path";
import type { ChildThreadInfo, SessionInfo } from "../../../../../../packages/protocol/schema";
import { aggregateChildThreads, childTitle } from "../../support/child-threads";
import { plainPreview } from '../../plain-preview';
import { rememberCapabilityObservation } from "../../telemetry";
import { observeClaudeTurn } from "./turn-state";
import { claudeContextReport } from "../../context-usage";
import { LIVE_MS, safeParse, stateFor, ts } from "../../support/common";
import { finishScan } from "../../cooperative-scan";
import { claudeCapabilityUsage, createClaudeCapabilityCollector } from "./activity";
import { claudeTranscriptRecord, pastedImageLabel } from "../../support/activity-helpers";
import { claudeChangedPaths, claudeCheckout, claudeRepositoryPaths } from "./repository-observation";
import {
  childLogsFingerprint,
  claudeChildLogPaths,
  claudeContextUsage,
  claudeSummaryCache,
  sumClaudeUsage,
} from "./shared";

import { readTranscriptRows } from "./transcript-reading";
import { readClaudeChild } from "./child-reading";

type ClaudeParseState = {
  sessionId: string;
  cwd?: string;
  launchCwd?: string;
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
  contextUsage?: SessionInfo["contextUsage"];
  repositoryPaths: string[];
  changedPaths: string[];
  turnEnded: boolean;
};

function applyClaudeLine(d: any, state: ClaudeParseState): void {
  if (!claudeTranscriptRecord(d)) return;
  observeClaudeTurn(d, state);
  if (d.isSidechain !== true) {
    state.repositoryPaths.push(...claudeRepositoryPaths(d));
    state.changedPaths.push(...claudeChangedPaths(d));
  }
  state.repositoryPaths = state.repositoryPaths.slice(-64);
  state.changedPaths = state.changedPaths.slice(-64);
  if (d.sessionId && !state.sessionId) state.sessionId = String(d.sessionId);
  if (d.isSidechain !== true) {
    if (typeof d.cwd === "string" && d.cwd.trim()) {
      state.cwd = d.cwd;
      state.launchCwd ??= d.cwd;
    }
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
    if (d.isSidechain !== true) state.contextUsage = claudeContextReport(usage, ts(d.timestamp) ?? 0) ?? state.contextUsage;
    if (d.message?.model && !state.model) state.model = String(d.message.model);
  }
  if (d.message?.role === "assistant") {
    const content = d.message.content;
    if (typeof content === "string" && content.trim()) {
      state.summary = plainPreview(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          state.summary = plainPreview(block.text);
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

function newProgress(device: number, inode: number, fallbackSessionId: string): ClaudeParseProgress {
  const state: ClaudeParseState = {
    sessionId: "", startedAt: 0, lastActivityAt: 0, lastMessageAt: 0,
    tokensSession: 0, tokensLastTurn: 0, repositoryPaths: [], changedPaths: [], turnEnded: false,
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

/** A subagent log is read again only when it changed, not whenever its parent chat did. */
function* readChildren(paths: string[], ownSession: SessionInfo, progress: ClaudeParseProgress,
  observations: ReturnType<typeof claudeCapabilityUsage>): Generator<void, ChildThreadInfo[]> {
  const childThreads: ChildThreadInfo[] = [];
  for (const childPath of paths) {
    const fingerprint = childLogsFingerprint([childPath]);
    let known = progress.children.get(childPath);
    if (known?.fingerprint !== fingerprint || !recordedClaudeUsageIsCurrent(known.observations)) {
      const child = yield* readClaudeChild(childPath, ownSession);
      if (!child) continue;
      known = { fingerprint, ...child };
      progress.children.set(childPath, known);
    }
    childThreads.push(known.summary);
    for (const observation of known.observations) {
      rememberCapabilityObservation(observations, observation);
    }
    mergeRecordedClaudeUsage(observations, known.observations);
    yield;
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
    yield* readTranscriptRows(fd, progress, fileStat.size, line => applyRow(line, progress));
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
    worktree: state.cwd ? claudeCheckout({ ...state, cwd: state.cwd }) : undefined,
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
    ...(state.contextUsage ? { contextUsage: state.contextUsage } : {}),
  };
  const actualChildPaths =
    state.sessionId === cachedSessionId ? childPaths : claudeChildLogPaths(file, state.sessionId);
  const scannedChildFingerprint = childLogsFingerprint(actualChildPaths);
  const observations = progress.capabilities.snapshot();
  const childThreads = yield* readChildren(actualChildPaths, ownSession, progress, observations);
  const session = aggregateChildThreads(ownSession, childThreads);
  claudeSummaryCache.set(file, {
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    // A child can grow between cooperative slices. Only cache the snapshot we started reading.
    childFingerprint: scannedChildFingerprint,
    session,
    tokensSession: session.tokensSession,
    observations,
    turnEnded: state.turnEnded,
    // A chat that has gone quiet gives its memory back and is read again if it returns.
    progress: Date.now() - session.lastActivityAt <= LIVE_MS ? progress : undefined,
  });
  return { session, tokensSession: session.tokensSession, childPaths: actualChildPaths };
}
