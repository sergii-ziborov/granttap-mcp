import { basename } from "node:path";
import type { ChildThreadInfo, SessionInfo } from "../../../../../packages/protocol/schema";
import { aggregateChildThreads, childTitle } from "../child-threads";
import { stateFor, TOKEN_WINDOW_MS, type Scan } from "../common";
import type { CapabilityObservation } from "../telemetry";
import { composerState, loadComposerCatalog, loadSidebarTitles, type ComposerRow } from "./catalog";
import {
  conversationIndex,
  cursorLogSnapshot,
  isParentConversationFile,
  mergeCapabilityUsage,
  transcriptSummary,
  workspaceLabel,
  type CursorLogFile,
  type CursorTranscriptSummary,
} from "./transcripts";

let filesBySession = new Map<string, CursorLogFile[]>();
let usageBySession = new Map<string, CapabilityObservation[]>();

export function cursorFiles(sessionId: string): CursorLogFile[] | undefined {
  return filesBySession.get(sessionId);
}

export function cursorUsage(sessionId: string): CapabilityObservation[] | undefined {
  return usageBySession.get(sessionId);
}

function childSummaries(
  sessionId: string,
  files: CursorLogFile[],
  cwd: string | undefined,
  composers: Map<string, ComposerRow>,
): { children: ChildThreadInfo[]; summaries: CursorTranscriptSummary[] } {
  const groups = new Map<string, CursorLogFile[]>();
  for (const file of files) {
    if (!file.isSubagent || !file.threadId) continue;
    const group = groups.get(file.threadId) ?? [];
    group.push(file);
    groups.set(file.threadId, group);
  }
  const summaries: CursorTranscriptSummary[] = [];
  const children = [...groups].map(([threadId, childFiles]): ChildThreadInfo => {
    const summary = transcriptSummary(`${sessionId}:${threadId}`, childFiles, sessionId, cwd);
    summaries.push(summary);
    const composer = composers.get(threadId);
    const lastActivityAt = Math.max(composer?.lastUpdatedAt ?? 0, summary.lastActivityAt);
    return {
      threadId,
      parentThreadId: sessionId,
      title: childTitle(composer?.name || summary.titleFromUser),
      depth: 1,
      state: composer ? composerState(composer.status, lastActivityAt) : stateFor(lastActivityAt),
      startedAt: Math.min(
        composer?.createdAt || summary.startedAt || lastActivityAt,
        summary.startedAt || composer?.createdAt || lastActivityAt,
      ),
      lastActivityAt,
      tokensSession: summary.tokensSession,
      tokensLastTurn: summary.tokensLastTurn,
    };
  });
  return { children, summaries };
}

type ScanContext = {
  now: number;
  sidebar: Map<string, string>;
  conversations: Map<string, CursorLogFile[]>;
  composers: Map<string, ComposerRow>;
  seen: Set<string>;
  subagents: Set<string>;
  sessions: SessionInfo[];
  files: Map<string, CursorLogFile[]>;
  usage: Map<string, CapabilityObservation[]>;
  tokensRecent: number;
};

function addComposerSession(context: ScanContext, composer: ComposerRow): void {
  if (!context.seen.add(composer.id)) return;
  const files = context.conversations.get(composer.id) ?? [];
  context.files.set(composer.id, files);
  const root = transcriptSummary(
    composer.id,
    files.filter((file) => !file.isSubagent),
    composer.id,
    composer.cwd,
  );
  const child = childSummaries(composer.id, files, composer.cwd, context.composers);
  const childLast = child.children.reduce((latest, item) => Math.max(latest, item.lastActivityAt), 0);
  const lastActivityAt = Math.max(composer.lastUpdatedAt, root.lastActivityAt, childLast) || context.now;
  const tokensSession = root.files.length ? root.tokensSession : composer.contextTokensUsed ?? 0;
  const session = aggregateChildThreads({
    sessionId: composer.id,
    agent: "cursor",
    title: (composer.name || context.sidebar.get(composer.id) || root.titleFromUser || "")
      .slice(0, 120) || undefined,
    cwd: composer.cwd,
    state: composerState(composer.status, lastActivityAt),
    startedAt: Math.min(composer.createdAt || lastActivityAt, root.startedAt || lastActivityAt),
    lastActivityAt,
    tokensSession,
    tokensLastTurn: root.files.length ? root.tokensLastTurn : 0,
    contextTokensUsed: composer.contextTokensUsed ?? root.contextTokensUsed ?? tokensSession,
    model: composer.model ?? root.model,
  }, child.children);
  session.contextTokensUsed = Math.max(session.contextTokensUsed ?? 0, session.tokensSession);
  context.usage.set(composer.id, mergeCapabilityUsage([root, ...child.summaries]));
  if (context.now - lastActivityAt <= TOKEN_WINDOW_MS) context.tokensRecent += session.tokensSession;
  context.sessions.push(session);
}

function addOrphanSession(context: ScanContext, file: CursorLogFile): void {
  if (file.isSubagent || !isParentConversationFile(file.path)) return;
  const sessionId = basename(file.path, ".jsonl");
  if (context.seen.has(sessionId) || context.subagents.has(sessionId)) return;
  context.seen.add(sessionId);
  const files = context.conversations.get(sessionId) ?? [file];
  context.files.set(sessionId, files);
  const cwd = workspaceLabel(file.path);
  const root = transcriptSummary(sessionId, files.filter((item) => !item.isSubagent), sessionId, cwd);
  const child = childSummaries(sessionId, files, cwd, context.composers);
  const childLast = child.children.reduce((latest, item) => Math.max(latest, item.lastActivityAt), 0);
  const lastActivityAt = Math.max(file.mtimeMs, root.lastActivityAt, childLast);
  const title = context.sidebar.get(sessionId) || root.titleFromUser;
  const session = aggregateChildThreads({
    sessionId,
    agent: "cursor",
    title: title && title !== cwd ? title : undefined,
    cwd,
    state: stateFor(lastActivityAt),
    startedAt: Math.min(file.birthtimeMs || lastActivityAt, root.startedAt || lastActivityAt),
    lastActivityAt,
    tokensSession: root.tokensSession,
    tokensLastTurn: root.tokensLastTurn,
    contextTokensUsed: root.contextTokensUsed,
    model: root.model,
  }, child.children);
  session.contextTokensUsed = Math.max(session.contextTokensUsed ?? 0, session.tokensSession);
  context.usage.set(sessionId, mergeCapabilityUsage([root, ...child.summaries]));
  if (context.now - lastActivityAt <= TOKEN_WINDOW_MS) context.tokensRecent += session.tokensSession;
  context.sessions.push(session);
}

export function scanCursor(): Scan {
  const composers = loadComposerCatalog();
  const snapshot = cursorLogSnapshot();
  const subagents = new Set(composers.flatMap((composer) => composer.subagentIds));
  const context: ScanContext = {
    now: Date.now(), sidebar: loadSidebarTitles(), conversations: conversationIndex(snapshot),
    composers: new Map(composers.map((composer) => [composer.id, composer])),
    seen: new Set(), subagents, sessions: [], files: new Map(), usage: new Map(), tokensRecent: 0,
  };
  const parents = composers.filter((composer) =>
    !subagents.has(composer.id) && !composer.isDraft && !composer.isArchived
      && (composer.name.length > 0 || composer.lastUpdatedAt > 0));
  for (const composer of parents) addComposerSession(context, composer);
  for (const file of snapshot) addOrphanSession(context, file);
  filesBySession = context.files;
  usageBySession = context.usage;
  return { sessions: context.sessions, tokensRecent: context.tokensRecent };
}
