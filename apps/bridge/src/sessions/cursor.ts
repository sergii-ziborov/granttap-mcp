/**
 * Cursor sidebar catalog + transcripts.
 *
 * Catalog (names / project grouping) — Composer store:
 *   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 *   cursorDiskKV key composerData:<id> → name, workspace fsPath, status, …
 *   Subagents listed in parent.subagentComposerIds must NOT become list rows.
 *
 * Transcripts (activity / token estimate):
 *   ~/.cursor/projects/<workspace>/agent-transcripts/<id>/<id>.jsonl
 *
 * Older path conversation-search.db is a title fallback only.
 */
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import type {
  ActivityEntry,
  ChildThreadInfo,
  SessionInfo,
  SessionState,
} from "../../../../packages/protocol/schema";
import {
  cursorTranscriptsRoot,
  recentLogs,
  safeParse,
  stateFor,
  ts,
  type Scan,
} from "./common";
import {
  classifyTool,
  estimateTokens,
  normalizeMcpServerName,
  pushEntry,
  toolSummary,
} from "./activity-helpers";
import {
  aggregateChildThreads,
  childEntryFields,
  childTitle,
} from "./child-threads";
import { TOKEN_WINDOW_MS } from "./common";
import {
  observeCapability,
  pendingCapabilityObservation,
  rememberCapabilityObservation,
  rememberPendingCapabilityCall,
  type CapabilityObservation,
  type PendingCapabilityTool,
} from "./telemetry";

type ComposerRow = {
  id: string;
  name: string;
  cwd?: string;
  lastUpdatedAt: number;
  createdAt: number;
  status?: string;
  isDraft: boolean;
  isArchived: boolean;
  subagentIds: string[];
  contextTokensUsed?: number;
  model?: string;
};

type CursorLogFile = {
  path: string;
  mtimeMs: number;
  birthtimeMs: number;
  size: number;
  isSubagent: boolean;
  ownerSessionId?: string;
  threadId?: string;
};

type CursorTranscriptSummary = {
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

function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text);
}

function titleFrom(text: string): string | undefined {
  const query = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i)?.[1] ?? text;
  const clean = query.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 120) : undefined;
}

function cursorStateDb(): string {
  return (
    process.env.GRANTTAP_CURSOR_STATE_DB ??
    join(
      homedir(),
      "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
    )
  );
}

function cursorSidebarDb(): string {
  return join(
    homedir(),
    "Library/Application Support/Cursor/User/globalStorage/conversation-search.db",
  );
}

function fileFingerprint(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

let sidebarTitlesCache:
  | { path: string; fingerprint: string; titles: Map<string, string> }
  | undefined;

/** Sidebar titles — conversation-search.db fallback. */
export function loadSidebarTitles(db = cursorSidebarDb()): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(db)) return out;
  // SQLite may keep fresh rows in WAL while the main DB stays untouched.
  const fingerprint = `${fileFingerprint(db)}:${fileFingerprint(`${db}-wal`)}`;
  if (
    sidebarTitlesCache?.path === db &&
    sidebarTitlesCache.fingerprint === fingerprint
  ) {
    return sidebarTitlesCache.titles;
  }
  try {
    const raw = execFileSync(
      "sqlite3",
      [
        "-json",
        db,
        "SELECT id, title FROM conversations WHERE title IS NOT NULL AND title != '';",
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
    const rows = (raw.trim() ? JSON.parse(raw) : []) as Array<{
      id?: string;
      title?: string;
    }>;
    for (const row of rows) {
      if (row.id && row.title?.trim()) out.set(row.id, row.title.trim().slice(0, 120));
    }
    sidebarTitlesCache = { path: db, fingerprint, titles: out };
  } catch {
    /* ignore */
  }
  return out;
}

let composerCache: { at: number; path: string; rows: ComposerRow[] } | undefined;
const COMPOSER_CACHE_MS = Number(process.env.GRANTTAP_COMPOSER_CACHE_MS ?? 15_000);
/**
 * Exact binary prefix range for `composerData:`. `;` is the immediate ASCII
 * successor to `:`, so this includes every suffix while letting SQLite use the
 * cursorDiskKV key index instead of scanning the multi-gigabyte value table.
 */
export const CURSOR_COMPOSER_KEY_RANGE_SQL =
  "key >= 'composerData:' AND key < 'composerData;'";

/** Primary Cursor sidebar rows from composerData:* in state.vscdb. */
export function loadComposerCatalog(dbPath = cursorStateDb()): ComposerRow[] {
  if (!existsSync(dbPath)) return [];
  if (
    composerCache &&
    composerCache.path === dbPath &&
    Date.now() - composerCache.at < COMPOSER_CACHE_MS
  ) {
    return composerCache.rows;
  }
  try {
    const raw = execFileSync(
      "sqlite3",
      [
        "-json",
        dbPath,
        `SELECT
          coalesce(json_extract(value,'$.composerId'), substr(key, 14)) AS id,
          coalesce(json_extract(value,'$.name'), '') AS name,
          json_extract(value,'$.lastUpdatedAt') AS lastUpdatedAt,
          json_extract(value,'$.createdAt') AS createdAt,
          json_extract(value,'$.status') AS status,
          coalesce(json_extract(value,'$.isDraft'), 0) AS isDraft,
          coalesce(json_extract(value,'$.isArchived'), 0) AS isArchived,
          json_extract(value,'$.workspaceIdentifier.uri.fsPath') AS fsPath,
          json_extract(value,'$.workspaceIdentifier.uri.path') AS path,
          json_extract(value,'$.subagentComposerIds') AS subagents,
          json_extract(value,'$.contextTokensUsed') AS contextTokensUsed,
          json_extract(value,'$.modelConfig.modelName') AS model
        FROM cursorDiskKV
        WHERE ${CURSOR_COMPOSER_KEY_RANGE_SQL};`,
      ],
      { encoding: "utf8", timeout: 12_000, maxBuffer: 32 * 1024 * 1024 },
    );
    if (!raw.trim()) return [];
    const rawRows = JSON.parse(raw) as Array<Record<string, unknown>>;
    const rows = rawRows
      .map((row): ComposerRow | null => {
        const id = typeof row.id === "string" ? row.id : "";
        if (!id) return null;
        let subagentIds: string[] = [];
        const rawSubs = row.subagents;
        if (typeof rawSubs === "string" && rawSubs.trim()) {
          try {
            const parsed = JSON.parse(rawSubs) as unknown;
            if (Array.isArray(parsed)) {
              subagentIds = parsed.filter((x): x is string => typeof x === "string");
            }
          } catch {
            /* ignore */
          }
        } else if (Array.isArray(rawSubs)) {
          subagentIds = rawSubs.filter((x): x is string => typeof x === "string");
        }
        const cwd =
          (typeof row.fsPath === "string" && row.fsPath) ||
          (typeof row.path === "string" && row.path) ||
          undefined;
        return {
          id,
          name: typeof row.name === "string" ? row.name.trim() : "",
          cwd: cwd?.startsWith("file://") ? cwd.replace(/^file:\/\//, "") : cwd,
          lastUpdatedAt: Number(row.lastUpdatedAt) || 0,
          createdAt: Number(row.createdAt) || 0,
          status: typeof row.status === "string" ? row.status : undefined,
          isDraft: Boolean(Number(row.isDraft) || row.isDraft === true),
          isArchived: Boolean(Number(row.isArchived) || row.isArchived === true),
          subagentIds,
          contextTokensUsed:
            Number(row.contextTokensUsed) > 0 ? Number(row.contextTokensUsed) : undefined,
          model: typeof row.model === "string" ? row.model : undefined,
        };
      })
      .filter((row): row is ComposerRow => row != null);
    composerCache = { at: Date.now(), path: dbPath, rows };
    return rows;
  } catch {
    return composerCache?.path === dbPath ? composerCache.rows : [];
  }
}

/**
 * Resolve a Cursor subagent composer back to the visible root chat.
 *
 * Cursor hook payloads currently expose only the child conversation id. The
 * same `subagentComposerIds` relationship used by the scanner is therefore the
 * authoritative local policy link. Resolution is transitive for nested agents;
 * ambiguous/cyclic data fails back to the incoming id so one chat can never
 * inherit another chat's controls by guesswork.
 */
export function cursorRootSessionId(
  rawSessionId: string | null | undefined,
  dbPath = cursorStateDb(),
): string | null {
  if (typeof rawSessionId !== "string") return null;
  const sessionId = rawSessionId.trim();
  if (!sessionId || sessionId.length > 256) return null;

  const parentsByChild = new Map<string, Set<string>>();
  for (const composer of loadComposerCatalog(dbPath)) {
    for (const childId of composer.subagentIds) {
      const boundedChild = childId.trim();
      if (!boundedChild || boundedChild.length > 256) continue;
      const parents = parentsByChild.get(boundedChild) ?? new Set<string>();
      parents.add(composer.id);
      parentsByChild.set(boundedChild, parents);
    }
  }

  let current = sessionId;
  const seen = new Set([current]);
  for (let depth = 0; depth < 32; depth += 1) {
    const parents = parentsByChild.get(current);
    if (!parents || parents.size === 0) return current;
    if (parents.size !== 1) return sessionId;
    const parent = [...parents][0];
    if (!parent || seen.has(parent)) return sessionId;
    seen.add(parent);
    current = parent;
  }
  return sessionId;
}

function composerState(status: string | undefined, lastActivityAt: number): SessionState {
  const s = (status ?? "").toLowerCase();
  if (
    s === "generating" ||
    s === "continuing" ||
    s === "applying" ||
    s === "running" ||
    s === "in_progress" ||
    s === "active"
  ) {
    return "working";
  }
  return stateFor(lastActivityAt);
}

/** Parent conversation transcript only — skip nested /subagents/*.jsonl. */
function isParentConversationFile(file: string): boolean {
  if (file.includes("/subagents/")) return false;
  const id = basename(file, ".jsonl");
  const folder = basename(dirname(file));
  return id === folder;
}

// The monitor scans every 5s, while refresh/activity requests can trigger a
// second scan immediately. Reuse the expensive directory index for at most 1s,
// but re-stat known logs so appended transcript rows invalidate summaries at
// once. Newly-created conversations become visible on the next full walk.
const CURSOR_LOG_INDEX_CACHE_MS = 1_000;
let cursorLogSnapshotCache:
  | { root: string; walkedAt: number; files: CursorLogFile[] }
  | undefined;

function cursorLogFile(path: string): CursorLogFile | undefined {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return undefined;
  }
  const isSubagent = path.includes("/subagents/");
  const ownerSessionId = isSubagent
    ? basename(dirname(dirname(path)))
    : isParentConversationFile(path)
      ? basename(path, ".jsonl")
      : undefined;
  return {
    path,
    mtimeMs: stat.mtimeMs,
    birthtimeMs: stat.birthtimeMs,
    size: stat.size,
    isSubagent,
    ownerSessionId,
    threadId: isSubagent ? basename(path, ".jsonl") : ownerSessionId,
  };
}

function cursorLogSnapshot(): CursorLogFile[] {
  const root = cursorTranscriptsRoot();
  const now = Date.now();
  if (
    cursorLogSnapshotCache?.root === root &&
    now - cursorLogSnapshotCache.walkedAt < CURSOR_LOG_INDEX_CACHE_MS
  ) {
    const refreshed = cursorLogSnapshotCache.files
      .map((file) => cursorLogFile(file.path))
      .filter((file): file is CursorLogFile => file != null);
    // Preserve walkedAt: frequent reads must not postpone discovery forever.
    cursorLogSnapshotCache = { root, walkedAt: cursorLogSnapshotCache.walkedAt, files: refreshed };
    return refreshed;
  }
  const out = recentLogs(root, 6)
    .map(cursorLogFile)
    .filter((file): file is CursorLogFile => file != null);
  cursorLogSnapshotCache = { root, walkedAt: now, files: out };
  return out;
}

function conversationIndex(snapshot: CursorLogFile[]): Map<string, CursorLogFile[]> {
  const index = new Map<string, CursorLogFile[]>();
  for (const file of snapshot) {
    if (!file.ownerSessionId) continue;
    const current = index.get(file.ownerSessionId) ?? [];
    current.push(file);
    index.set(file.ownerSessionId, current);
  }
  for (const files of index.values()) {
    files.sort((a, b) => {
      if (a.isSubagent !== b.isSubagent) return a.isSubagent ? 1 : -1;
      return a.mtimeMs - b.mtimeMs;
    });
  }
  return index;
}

function workspaceLabel(file: string): string | undefined {
  const parts = file.split("/");
  const idx = parts.lastIndexOf("projects");
  if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
  return undefined;
}

const MAX_TRANSCRIPT_SUMMARY_CACHE = 512;
const transcriptSummaryCache = new Map<
  string,
  { fingerprint: string; summary: CursorTranscriptSummary }
>();
let cursorConversationFilesBySession = new Map<string, CursorLogFile[]>();
let cursorCapabilityUsageBySession = new Map<string, CapabilityObservation[]>();

function transcriptFingerprint(files: CursorLogFile[]): string {
  return files
    .map((file) => `${file.path}\u0000${file.mtimeMs}\u0000${file.size}`)
    .join("\u0001");
}

function transcriptSummary(
  cacheKey: string,
  files: CursorLogFile[],
  rootSessionId = cacheKey,
  cwd?: string,
): CursorTranscriptSummary {
  if (files.length === 0) {
    transcriptSummaryCache.delete(cacheKey);
    return {
      lastActivityAt: 0,
      startedAt: 0,
      files: [],
      tokensSession: 0,
      tokensLastTurn: 0,
      contextTokensUsed: 0,
      observations: [],
    };
  }
  const fingerprint = `${transcriptFingerprint(files)}\u0002${rootSessionId}\u0002${cwd ?? ""}`;
  const cached = transcriptSummaryCache.get(cacheKey);
  if (cached?.fingerprint === fingerprint) {
    // Refresh insertion order so the bounded map behaves like an LRU.
    transcriptSummaryCache.delete(cacheKey);
    transcriptSummaryCache.set(cacheKey, cached);
    return cached.summary;
  }

  let tokensSession = 0;
  let tokensLastTurn = 0;
  let lastRole: string | undefined;
  let lastActivityAt = 0;
  let startedAt = 0;
  let model: string | undefined;
  let titleFromUser: string | undefined;
  const pending = new Map<string, PendingCapabilityTool>();
  const observations: CapabilityObservation[] = [];
  for (const file of files) {
    if (file.mtimeMs > lastActivityAt) lastActivityAt = file.mtimeMs;
    const birth = file.birthtimeMs || file.mtimeMs;
    if (!startedAt || birth < startedAt) startedAt = birth;

    let lines: string[];
    try {
      lines = readFileSync(file.path, "utf8").split("\n");
    } catch {
      continue;
    }
    for (const [lineIndex, line] of lines.entries()) {
      const item = safeParse(line);
      if (!item) continue;
      const content = item.message?.content;
      if (Array.isArray(content)) {
        const sourceThreadId = file.threadId ?? rootSessionId;
        const rowAt = ts(item.timestamp) || file.mtimeMs;
        for (const [blockIndex, block] of content.entries()) {
          if (block?.type === "tool_use" && typeof block.name === "string") {
            const callId =
              typeof block.id === "string" && block.id
                ? block.id
                : `${basename(file.path, ".jsonl")}:${lineIndex}:${blockIndex}`;
            const pendingKey = `${sourceThreadId}\u0000${callId}`;
            const input = block.input;
            let toolName = block.name;
            if (
              /^(CallMcpTool|GetMcpTools)$/i.test(toolName) &&
              input &&
              typeof input === "object"
            ) {
              const meta = input as Record<string, unknown>;
              const server =
                typeof meta.server === "string"
                  ? normalizeMcpServerName(meta.server)
                  : "";
              const inner =
                typeof meta.toolName === "string" && meta.toolName.trim()
                  ? meta.toolName.trim()
                  : toolName;
              if (server) toolName = `mcp__${server}__${inner}`;
            }
            const pendingTool: PendingCapabilityTool = {
              sourceId: `${sourceThreadId}:${callId}`,
              sessionId: rootSessionId,
              toolName,
              input,
              createdAt: rowAt,
              cwd,
            };
            if (pendingCapabilityObservation(pendingTool)) {
              rememberPendingCapabilityCall(pending, pendingKey, pendingTool);
            }
            continue;
          }
          if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") {
            continue;
          }
          const pendingKey = `${sourceThreadId}\u0000${block.tool_use_id}`;
          const pendingTool = pending.get(pendingKey);
          if (!pendingTool) continue;
          const observation =
            observeCapability(pendingTool, block.content, rowAt) ??
            pendingCapabilityObservation(pendingTool);
          if (observation) rememberCapabilityObservation(observations, observation);
          pending.delete(pendingKey);
        }
      }
      if (!file.isSubagent) {
        if (!titleFromUser && item.role === "user") {
          titleFromUser = titleFrom(textBlocks(item.message?.content).join("\n"));
        }
        const candidate = item.message?.model ?? item.model;
        if (typeof candidate === "string") model = candidate;
      }
      if (!item?.role) continue;
      const text = textBlocks(item.message?.content).join("\n");
      const usage = item.message?.usage ?? item.usage;
      let spent = 0;
      if (usage && typeof usage === "object") {
        const u = usage as Record<string, unknown>;
        spent =
          Number(u.input_tokens ?? u.inputTokens ?? 0) +
          Number(u.output_tokens ?? u.outputTokens ?? 0) +
          Number(u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? 0);
      }
      if (!spent && text) spent = estimateTokens(text);
      if (!spent) continue;
      tokensSession += spent;
      if (item.role === "assistant" || lastRole === "user") tokensLastTurn = spent;
      lastRole = item.role;
    }
  }
  for (const pendingTool of pending.values()) {
    const observation = pendingCapabilityObservation(pendingTool);
    if (observation) rememberCapabilityObservation(observations, observation);
  }
  const summary: CursorTranscriptSummary = {
    lastActivityAt,
    startedAt,
    files: files.map((file) => file.path),
    model,
    titleFromUser,
    tokensSession,
    tokensLastTurn,
    contextTokensUsed: tokensSession,
    observations,
  };
  transcriptSummaryCache.delete(cacheKey);
  transcriptSummaryCache.set(cacheKey, { fingerprint, summary });
  while (transcriptSummaryCache.size > MAX_TRANSCRIPT_SUMMARY_CACHE) {
    const oldest = transcriptSummaryCache.keys().next().value as string | undefined;
    if (!oldest) break;
    transcriptSummaryCache.delete(oldest);
  }
  return summary;
}

function mergeCapabilityUsage(
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

export function scanCursor(): Scan {
  const sessions: SessionInfo[] = [];
  const seen = new Set<string>();
  let tokensRecent = 0;
  const now = Date.now();
  const sidebarTitles = loadSidebarTitles();
  const composers = loadComposerCatalog();
  // One bounded filesystem walk per scan. Every parent and orphan below reuses
  // this immutable view instead of walking ~/.cursor/projects independently.
  const logSnapshot = cursorLogSnapshot();
  const conversations = conversationIndex(logSnapshot);
  const nextConversationFiles = new Map<string, CursorLogFile[]>();
  const nextCapabilityUsage = new Map<string, CapabilityObservation[]>();
  const subagentIds = new Set<string>();
  const composerById = new Map(composers.map((composer) => [composer.id, composer]));
  for (const c of composers) {
    for (const id of c.subagentIds) subagentIds.add(id);
  }

  // Sidebar parents only — never dump Task/subagent composers as top-level chats.
  const parents = composers.filter(
    (c) =>
      !subagentIds.has(c.id) &&
      !c.isDraft &&
      !c.isArchived &&
      (c.name.length > 0 || c.lastUpdatedAt > 0),
  );

  for (const c of parents) {
    if (!seen.add(c.id)) continue;
    const conversationFiles = conversations.get(c.id) ?? [];
    nextConversationFiles.set(c.id, conversationFiles);
    const rootFiles = conversationFiles.filter((file) => !file.isSubagent);
    const tx = transcriptSummary(c.id, rootFiles, c.id, c.cwd);
    const capabilitySummaries = [tx];
    const childGroups = new Map<string, CursorLogFile[]>();
    for (const file of conversationFiles) {
      if (!file.isSubagent || !file.threadId) continue;
      const group = childGroups.get(file.threadId) ?? [];
      group.push(file);
      childGroups.set(file.threadId, group);
    }
    const childThreads: ChildThreadInfo[] = [...childGroups].map(([threadId, files]) => {
      const summary = transcriptSummary(`${c.id}:${threadId}`, files, c.id, c.cwd);
      capabilitySummaries.push(summary);
      const composer = composerById.get(threadId);
      const lastActivityAt = Math.max(composer?.lastUpdatedAt ?? 0, summary.lastActivityAt);
      return {
        threadId,
        parentThreadId: c.id,
        title: childTitle(composer?.name || summary.titleFromUser),
        depth: 1,
        state: composerState(composer?.status, lastActivityAt),
        startedAt: Math.min(
          composer?.createdAt || summary.startedAt || lastActivityAt,
          summary.startedAt || composer?.createdAt || lastActivityAt,
        ),
        lastActivityAt,
        tokensSession: summary.tokensSession,
        tokensLastTurn: summary.tokensLastTurn,
      };
    });
    const childLastActivityAt = childThreads.reduce(
      (latest, child) => Math.max(latest, child.lastActivityAt), 0,
    );
    const lastActivityAt = Math.max(c.lastUpdatedAt, tx.lastActivityAt, childLastActivityAt) || now;
    const startedAt = Math.min(
      c.createdAt || lastActivityAt,
      tx.startedAt || lastActivityAt,
    );
    const title =
      (c.name || sidebarTitles.get(c.id) || tx.titleFromUser || "").slice(0, 120) ||
      undefined;
    const estimated = tx.files.length ? tx : undefined;
    const tokensSession = estimated?.tokensSession ?? c.contextTokensUsed ?? 0;
    const tokensLastTurn = estimated?.tokensLastTurn ?? 0;
    const contextTokensUsed = c.contextTokensUsed ?? estimated?.contextTokensUsed ?? tokensSession;
    const session = aggregateChildThreads({
      sessionId: c.id,
      agent: "cursor",
      title,
      cwd: c.cwd,
      state: composerState(c.status, lastActivityAt),
      startedAt,
      lastActivityAt,
      tokensSession,
      tokensLastTurn,
      contextTokensUsed,
      model: c.model ?? tx.model,
    }, childThreads);
    session.contextTokensUsed = Math.max(session.contextTokensUsed ?? 0, session.tokensSession);
    nextCapabilityUsage.set(c.id, mergeCapabilityUsage(capabilitySummaries));
    if (now - session.lastActivityAt <= TOKEN_WINDOW_MS) tokensRecent += session.tokensSession;
    sessions.push(session);
  }

  // Orphan parent transcripts (no composerData) — keep so Allows-linked folders stay visible.
  for (const file of logSnapshot) {
    if (file.isSubagent || !isParentConversationFile(file.path)) continue;
    const sessionId = basename(file.path, ".jsonl");
    if (seen.has(sessionId) || subagentIds.has(sessionId)) continue;
    seen.add(sessionId);

    const conversationFiles = conversations.get(sessionId) ?? [file];
    nextConversationFiles.set(sessionId, conversationFiles);
    const rootFiles = conversationFiles.filter((item) => !item.isSubagent);
    const cwd = workspaceLabel(file.path);
    const tx = transcriptSummary(sessionId, rootFiles, sessionId, cwd);
    const capabilitySummaries = [tx];
    const childGroups = new Map<string, CursorLogFile[]>();
    for (const item of conversationFiles) {
      if (!item.isSubagent || !item.threadId) continue;
      const group = childGroups.get(item.threadId) ?? [];
      group.push(item);
      childGroups.set(item.threadId, group);
    }
    const childThreads: ChildThreadInfo[] = [...childGroups].map(([threadId, files]) => {
      const summary = transcriptSummary(`${sessionId}:${threadId}`, files, sessionId, cwd);
      capabilitySummaries.push(summary);
      return {
        threadId,
        parentThreadId: sessionId,
        title: childTitle(summary.titleFromUser),
        depth: 1,
        state: stateFor(summary.lastActivityAt),
        startedAt: summary.startedAt || summary.lastActivityAt,
        lastActivityAt: summary.lastActivityAt,
        tokensSession: summary.tokensSession,
        tokensLastTurn: summary.tokensLastTurn,
      };
    });
    const childLastActivityAt = childThreads.reduce(
      (latest, child) => Math.max(latest, child.lastActivityAt), 0,
    );
    const lastActivityAt = Math.max(file.mtimeMs, tx.lastActivityAt, childLastActivityAt);
    const startedAt = Math.min(file.birthtimeMs || lastActivityAt, tx.startedAt || lastActivityAt);
    const title =
      sidebarTitles.get(sessionId) ||
      tx.titleFromUser ||
      undefined;
    const session = aggregateChildThreads({
      sessionId,
      agent: "cursor",
      title: title && title !== cwd ? title : undefined,
      cwd,
      state: stateFor(lastActivityAt),
      startedAt,
      lastActivityAt,
      tokensSession: tx.tokensSession,
      tokensLastTurn: tx.tokensLastTurn,
      contextTokensUsed: tx.contextTokensUsed,
      model: tx.model,
    }, childThreads);
    session.contextTokensUsed = Math.max(session.contextTokensUsed ?? 0, session.tokensSession);
    nextCapabilityUsage.set(sessionId, mergeCapabilityUsage(capabilitySummaries));
    if (now - session.lastActivityAt <= TOKEN_WINDOW_MS) tokensRecent += session.tokensSession;
    sessions.push(session);
  }

  cursorConversationFilesBySession = nextConversationFiles;
  cursorCapabilityUsageBySession = nextCapabilityUsage;

  return { sessions, tokensRecent };
}

function appendFileActivity(
  out: ActivityEntry[],
  seen: Set<string>,
  sessionId: string,
  file: string,
  baseTime: number,
  indexOffset: number,
  child?: ChildThreadInfo,
): void {
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").split("\n");
  } catch {
    return;
  }

  const childFields = child ? childEntryFields(child) : {};
  const sourceThreadId = child?.threadId ?? sessionId;
  const entryId = (createdAt: number, ordinal: number): string | undefined =>
    child ? `${sourceThreadId}:${createdAt}:${ordinal}` : undefined;
  lines.forEach((line, index) => {
    const item = safeParse(line);
    if (!item) return;
    const createdAt =
      (typeof item.timestamp === "number" ? item.timestamp : 0) ||
      baseTime + (indexOffset + index) * 1_000;
    const role = item.role;
    if (role === "user") {
      const text = textBlocks(item.message?.content).join("\n").trim();
      if (!text) return;
      const ordinal = indexOffset + index;
      pushEntry(
        out, seen, sessionId, "user", text, createdAt, ordinal,
        childFields, entryId(createdAt, ordinal),
      );
      return;
    }
    if (role !== "assistant") return;
    const content = item.message?.content;
    if (typeof content === "string") {
      const ordinal = indexOffset + index;
      pushEntry(
        out, seen, sessionId, "message", content, createdAt, ordinal,
        childFields, entryId(createdAt, ordinal),
      );
      return;
    }
    if (!Array.isArray(content)) return;
    content.forEach((block: any, blockIndex: number) => {
      const seq = (indexOffset + index) * 100 + blockIndex;
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        pushEntry(
          out, seen, sessionId, "message", block.text, createdAt, seq,
          childFields, entryId(createdAt, seq),
        );
      } else if (block?.type === "tool_use") {
        const classified = classifyTool(block.name, block.input);
        pushEntry(
          out,
          seen,
          sessionId,
          "tool",
          toolSummary(block.name, block.input),
          createdAt,
          seq,
          {
            ...childFields,
            ...classified,
            estimatedContextTokens: estimateTokens(block.input),
          },
          entryId(createdAt, seq),
        );
      }
    });
  });
}

export function cursorActivity(session: SessionInfo): ActivityEntry[] {
  let files = cursorConversationFilesBySession.get(session.sessionId);
  if (!files) {
    scanCursor();
    files = cursorConversationFilesBySession.get(session.sessionId) ?? [];
  }

  const out: ActivityEntry[] = [];
  const seen = new Set<string>();
  const childById = new Map(session.childThreads?.map((child) => [child.threadId, child]));
  files.forEach((file, fileIndex) => {
    const base = file.birthtimeMs || file.mtimeMs || session.startedAt;
    const childId = file.isSubagent ? file.threadId : undefined;
    const child = childId
      ? childById.get(childId) ?? {
          threadId: childId,
          parentThreadId: session.sessionId,
          title: undefined,
          depth: 1,
          state: stateFor(base),
          startedAt: base,
          lastActivityAt: base,
          tokensSession: 0,
          tokensLastTurn: 0,
        }
      : undefined;
    appendFileActivity(
      out, seen, session.sessionId, file.path, base, fileIndex * 10_000, child,
    );
  });
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** Bounded MCP/skill/CLI observations produced by the most recent log scan. */
export function cursorCapabilityUsage(session: SessionInfo): CapabilityObservation[] {
  let observations = cursorCapabilityUsageBySession.get(session.sessionId);
  if (!observations) {
    scanCursor();
    observations = cursorCapabilityUsageBySession.get(session.sessionId);
  }
  return observations ?? [];
}
