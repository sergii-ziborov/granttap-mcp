import { basename } from "node:path";
import type { ChildThreadInfo, SessionInfo } from "../../../../../packages/protocol/schema";
import { aggregateChildThreads, childTitle } from "../child-threads";
import { stateFor, TOKEN_WINDOW_MS, type Scan } from "../common";
import type { CapabilityObservation } from "../telemetry";
import {
  composerActivityAt,
  composerParentSets,
  composerState,
  isCursorTaskCloneId,
  isNestedComposer,
  loadComposerCatalog,
  loadSidebarTitles,
  type ComposerRow,
} from "./catalog";
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

function childFromComposer(composer: ComposerRow, parentThreadId: string): ChildThreadInfo {
  const lastActivityAt = composerActivityAt(composer);
  return {
    threadId: composer.id,
    parentThreadId,
    title: childTitle(composer.name),
    depth: 1,
    state: composerState(composer.status, lastActivityAt),
    startedAt: composer.createdAt || lastActivityAt,
    lastActivityAt,
    tokensSession: composer.contextTokensUsed ?? 0,
    tokensLastTurn: 0,
  };
}

function childSummaries(
  sessionId: string,
  files: CursorLogFile[],
  cwd: string | undefined,
  composers: Map<string, ComposerRow>,
  descendants: ComposerRow[] = [],
): { children: ChildThreadInfo[]; summaries: CursorTranscriptSummary[] } {
  const groups = new Map<string, CursorLogFile[]>();
  for (const file of files) {
    if (!file.isSubagent || !file.threadId || isCursorTaskCloneId(file.threadId)) continue;
    const group = groups.get(file.threadId) ?? [];
    group.push(file);
    groups.set(file.threadId, group);
  }
  const summaries: CursorTranscriptSummary[] = [];
  const byId = new Map<string, ChildThreadInfo>();
  for (const [threadId, childFiles] of groups) {
    const summary = transcriptSummary(`${sessionId}:${threadId}`, childFiles, sessionId, cwd);
    summaries.push(summary);
    const composer = composers.get(threadId);
    const lastActivityAt = Math.max(composer ? composerActivityAt(composer) : 0, summary.lastActivityAt);
    byId.set(threadId, {
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
    });
  }
  for (const composer of descendants) {
    if (isCursorTaskCloneId(composer.id)) continue;
    const existing = byId.get(composer.id);
    const created = childFromComposer(composer, sessionId);
    if (!existing) {
      byId.set(composer.id, created);
      continue;
    }
    existing.title = existing.title || created.title;
    existing.lastActivityAt = Math.max(existing.lastActivityAt, created.lastActivityAt);
    existing.startedAt = Math.min(existing.startedAt || created.startedAt, created.startedAt);
    existing.tokensSession = Math.max(existing.tokensSession, created.tokensSession);
    existing.tokensLastTurn = Math.max(existing.tokensLastTurn, created.tokensLastTurn);
    if (created.state === "working") existing.state = "working";
  }
  return { children: [...byId.values()], summaries };
}

type ScanContext = {
  now: number;
  sidebar: Map<string, string>;
  conversations: Map<string, CursorLogFile[]>;
  composers: Map<string, ComposerRow>;
  seen: Set<string>;
  subagents: Set<string>;
  rootOf: (id: string) => string;
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
  const descendants = [...context.composers.values()].filter((row) =>
    row.id !== composer.id
    && context.rootOf(row.id) === composer.id
    && !isCursorTaskCloneId(row.id));
  const child = childSummaries(composer.id, files, composer.cwd, context.composers, descendants);
  const childLast = child.children.reduce((latest, item) => Math.max(latest, item.lastActivityAt), 0);
  const lastActivityAt = Math.max(
    composerActivityAt(composer), root.lastActivityAt, childLast,
  );
  const tokensSession = root.files.length ? root.tokensSession : composer.contextTokensUsed ?? 0;
  const session = aggregateChildThreads({
    sessionId: composer.id,
    agent: "cursor",
    title: childTitle(composer.name || context.sidebar.get(composer.id) || root.titleFromUser)
      ?.slice(0, 120),
    cwd: composer.cwd,
    state: composerState(composer.status, lastActivityAt),
    startedAt: Math.min(
      composer.createdAt || lastActivityAt || context.now,
      root.startedAt || lastActivityAt || context.now,
    ),
    lastActivityAt: lastActivityAt || composer.createdAt,
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
  const title = childTitle(context.sidebar.get(sessionId) || root.titleFromUser);
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

function rootComposerId(
  sessionId: string,
  parentsByChild: Map<string, Set<string>>,
  composers: Map<string, ComposerRow>,
): string {
  let current = sessionId;
  const seen = new Set([current]);
  for (let depth = 0; depth < 32; depth += 1) {
    const parents = parentsByChild.get(current);
    if (parents && parents.size > 1) return sessionId;
    if (parents && parents.size === 1) {
      const parent = [...parents][0]!;
      if (seen.has(parent)) return sessionId;
      seen.add(parent);
      current = parent;
      continue;
    }
    const root = composers.get(current)?.rootParentConversationId;
    if (root && composers.has(root) && !seen.has(root)) return root;
    return current;
  }
  return sessionId;
}

export function scanCursor(): Scan {
  const composers = loadComposerCatalog();
  const snapshot = cursorLogSnapshot();
  const parentsByChild = composerParentSets(composers);
  const byId = new Map(composers.map((composer) => [composer.id, composer]));
  const subagents = new Set<string>();
  for (const composer of composers) {
    if (isNestedComposer(composer) || parentsByChild.has(composer.id)) subagents.add(composer.id);
  }
  const context: ScanContext = {
    now: Date.now(), sidebar: loadSidebarTitles(), conversations: conversationIndex(snapshot),
    composers: byId, seen: new Set(), subagents,
    rootOf: (id) => rootComposerId(id, parentsByChild, byId),
    sessions: [], files: new Map(), usage: new Map(), tokensRecent: 0,
  };
  const parents = composers.filter((composer) =>
    !subagents.has(composer.id) && !composer.isDraft && !composer.isArchived
      && (composer.name.length > 0 || composerActivityAt(composer) > 0));
  for (const composer of parents) addComposerSession(context, composer);
  for (const file of snapshot) addOrphanSession(context, file);
  filesBySession = context.files;
  usageBySession = context.usage;
  return { sessions: context.sessions, tokensRecent: context.tokensRecent };
}
