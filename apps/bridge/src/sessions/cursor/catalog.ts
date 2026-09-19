import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionState } from "../../../../../packages/protocol/schema";
import { stateFor, WORKING_MS } from "../common";

export type ComposerRow = {
  id: string;
  name: string;
  cwd?: string;
  lastUpdatedAt: number;
  createdAt: number;
  status?: string;
  isDraft: boolean;
  isArchived: boolean;
  subagentIds: string[];
  subComposerIds: string[];
  parentComposerId?: string;
  rootParentConversationId?: string;
  forkedFromComposerId?: string;
  unfinishedRunAt?: number;
  checkpointAt?: number;
  isBestOfNSubcomposer: boolean;
  contextTokensUsed?: number;
  model?: string;
};

function cursorStateDb(): string {
  return process.env.GRANTTAP_CURSOR_STATE_DB ?? join(
    homedir(),
    "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
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

export function loadSidebarTitles(db = cursorSidebarDb()): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(db)) return out;
  const fingerprint = `${fileFingerprint(db)}:${fileFingerprint(`${db}-wal`)}`;
  if (sidebarTitlesCache?.path === db && sidebarTitlesCache.fingerprint === fingerprint) {
    return sidebarTitlesCache.titles;
  }
  try {
    const raw = execFileSync("sqlite3", [
      "-json",
      db,
      "SELECT id, title FROM conversations WHERE title IS NOT NULL AND title != '';",
    ], { encoding: "utf8", timeout: 5_000 });
    const rows = (raw.trim() ? JSON.parse(raw) : []) as Array<{ id?: string; title?: string }>;
    for (const row of rows) {
      if (row.id && row.title?.trim()) out.set(row.id, row.title.trim().slice(0, 120));
    }
    sidebarTitlesCache = { path: db, fingerprint, titles: out };
  } catch {
    // The sidebar database is only a title fallback.
  }
  return out;
}

let composerCache: { at: number; path: string; rows: ComposerRow[] } | undefined;
const COMPOSER_CACHE_MS = Number(process.env.GRANTTAP_COMPOSER_CACHE_MS ?? 15_000);
export const CURSOR_COMPOSER_KEY_RANGE_SQL =
  "key >= 'composerData:' AND key < 'composerData;'";

function stringIds(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function optionalId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value.trim().length <= 256
    ? value.trim()
    : undefined;
}

function composerRows(raw: string): ComposerRow[] {
  if (!raw.trim()) return [];
  return (JSON.parse(raw) as Array<Record<string, unknown>>)
    .map((row): ComposerRow | null => {
      const id = typeof row.id === "string" ? row.id : "";
      if (!id) return null;
      const cwd = (typeof row.fsPath === "string" && row.fsPath)
        || (typeof row.path === "string" && row.path)
        || undefined;
      return {
        id,
        name: typeof row.name === "string" ? row.name.trim() : "",
        cwd: cwd?.startsWith("file://") ? cwd.replace(/^file:\/\//, "") : cwd,
        lastUpdatedAt: Number(row.lastUpdatedAt) || 0,
        createdAt: Number(row.createdAt) || 0,
        status: typeof row.status === "string" ? row.status : undefined,
        isDraft: Boolean(Number(row.isDraft) || row.isDraft === true),
        isArchived: Boolean(Number(row.isArchived) || row.isArchived === true),
        subagentIds: stringIds(row.subagents),
        subComposerIds: stringIds(row.subComposers),
        parentComposerId: optionalId(row.parentComposerId),
        rootParentConversationId: optionalId(row.rootParentConversationId),
        forkedFromComposerId: optionalId(row.forkedFromComposerId),
        unfinishedRunAt: Number(row.unfinishedRunAt) > 0 ? Number(row.unfinishedRunAt) : undefined,
        checkpointAt: Number(row.checkpointAt) > 0 ? Number(row.checkpointAt) : undefined,
        isBestOfNSubcomposer: Boolean(Number(row.isBestOfNSubcomposer) || row.isBestOfNSubcomposer === true),
        contextTokensUsed: Number(row.contextTokensUsed) > 0
          ? Number(row.contextTokensUsed)
          : undefined,
        model: typeof row.model === "string" ? row.model : undefined,
      };
    })
    .filter((row): row is ComposerRow => row != null);
}

export function loadComposerCatalog(dbPath = cursorStateDb()): ComposerRow[] {
  if (!existsSync(dbPath)) return [];
  if (composerCache?.path === dbPath && Date.now() - composerCache.at < COMPOSER_CACHE_MS) {
    return composerCache.rows;
  }
  try {
    const raw = execFileSync("sqlite3", ["-json", dbPath, `SELECT
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
      json_extract(value,'$.subComposerIds') AS subComposers,
      json_extract(value,'$.subagentInfo.parentComposerId') AS parentComposerId,
      json_extract(value,'$.subagentInfo.rootParentConversationId') AS rootParentConversationId,
      json_extract(value,'$.subagentInfo.forkedFromComposerId') AS forkedFromComposerId,
      json_extract(value,'$.unfinishedRunAt') AS unfinishedRunAt,
      json_extract(value,'$.conversationCheckpointLastUpdatedAt') AS checkpointAt,
      coalesce(json_extract(value,'$.isBestOfNSubcomposer'), 0) AS isBestOfNSubcomposer,
      json_extract(value,'$.contextTokensUsed') AS contextTokensUsed,
      json_extract(value,'$.modelConfig.modelName') AS model
      FROM cursorDiskKV WHERE ${CURSOR_COMPOSER_KEY_RANGE_SQL};`], {
      encoding: "utf8",
      timeout: 12_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const rows = composerRows(raw);
    composerCache = { at: Date.now(), path: dbPath, rows };
    return rows;
  } catch {
    return composerCache?.path === dbPath ? composerCache.rows : [];
  }
}

export function composerParentSets(composers: ComposerRow[]): Map<string, Set<string>> {
  const byId = new Map(composers.map((composer) => [composer.id, composer]));
  const parentsByChild = new Map<string, Set<string>>();
  const add = (childId: string | undefined, parentId: string | undefined): void => {
    const child = childId?.trim();
    const parent = parentId?.trim();
    if (!child || !parent || child === parent || child.length > 256 || parent.length > 256) return;
    const parents = parentsByChild.get(child) ?? new Set<string>();
    parents.add(parent);
    parentsByChild.set(child, parents);
  };
  for (const composer of composers) {
    for (const childId of [...composer.subagentIds, ...composer.subComposerIds]) {
      add(childId, composer.id);
    }
    add(composer.id, composer.parentComposerId);
    add(composer.id, composer.forkedFromComposerId);
    if (composer.id.startsWith("task-") && byId.has(composer.id.slice(5))) {
      add(composer.id, composer.id.slice(5));
    }
  }
  return parentsByChild;
}

/** Task-tool clones and catalog children are not their own chats. */
export function isNestedComposer(composer: ComposerRow): boolean {
  return Boolean(
    composer.parentComposerId
    || composer.rootParentConversationId
    || composer.forkedFromComposerId
    || composer.isBestOfNSubcomposer
    || composer.id.startsWith("task-"),
  );
}

export function cursorRootSessionId(
  rawSessionId: string | null | undefined,
  dbPath = cursorStateDb(),
): string | null {
  if (typeof rawSessionId !== "string") return null;
  const sessionId = rawSessionId.trim();
  if (!sessionId || sessionId.length > 256) return null;
  const composers = loadComposerCatalog(dbPath);
  const parentsByChild = composerParentSets(composers);
  const row = composers.find((composer) => composer.id === sessionId);
  if (row?.rootParentConversationId && !parentsByChild.has(sessionId)) {
    return row.rootParentConversationId;
  }
  let current = sessionId;
  const seen = new Set([current]);
  for (let depth = 0; depth < 32; depth += 1) {
    const parents = parentsByChild.get(current);
    if (!parents || parents.size === 0) {
      return composers.find((composer) => composer.id === current)?.rootParentConversationId
        ?? current;
    }
    if (parents.size !== 1) return sessionId;
    const parent = [...parents][0];
    if (!parent || seen.has(parent)) return sessionId;
    seen.add(parent);
    current = parent;
  }
  return sessionId;
}

export function composerActivityAt(composer: ComposerRow): number {
  return Math.max(
    composer.lastUpdatedAt,
    composer.unfinishedRunAt ?? 0,
    composer.checkpointAt ?? 0,
  );
}

export function composerState(status: string | undefined, lastActivityAt: number): SessionState {
  const value = (status ?? "").toLowerCase();
  if (["generating", "continuing", "applying", "running", "in_progress", "active"].includes(value)) {
    return "working";
  }
  if ((value === "completed" || value === "cancelled") && lastActivityAt <= 0) return "idle";
  if ((value === "completed" || value === "cancelled")
    && Date.now() - lastActivityAt > WORKING_MS) {
    return "idle";
  }
  return lastActivityAt > 0 ? stateFor(lastActivityAt) : "idle";
}
