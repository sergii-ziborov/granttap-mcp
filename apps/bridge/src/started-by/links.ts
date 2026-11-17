/**
 * Which chat started each chat, kept after both are over.
 *
 * A run's live process names the chat that started it, but not the session the run is about to
 * write, so a captured run waits here (`runs`) until the session it started is in the catalog. The
 * link is then written keyed by that child session (`links`) and outlives the run, its process and
 * the parent's transcript. Only ids, providers, a folder and clock times are kept.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFile } from "../config/access/write-private";
import { configDir } from "../config/runtime/paths";
import { HISTORY_RETENTION_MS } from "../sessions/support/common";
import { lineageAgent, SESSION_ID, type LineageAgent } from "./headless";

export type StartedBy = { agent: LineageAgent; sessionId: string };

/** How a link was learned: from the child's live process, or after the fact from the parent's transcript. */
export type StartedBySource = "process" | "transcript";

export type StartedByLink = StartedBy & { parent: StartedBy; source: StartedBySource; at: number };

/** A headless run whose process named its parent, not yet joined to the session it started. */
export type StartedRun = {
  agent: LineageAgent;
  pid: number;
  /** When the process started, as the process listing tells it. */
  startedAt: number;
  folder?: string;
  sessionId?: string;
  parent: StartedBy;
  capturedAt: number;
};

const MAX_LINKS = 4_000;
const MAX_RUNS = 256;
/** A run whose session never appeared (it failed before writing one) is let go after a day. */
export const RUN_TTL_MS = 24 * 60 * 60_000;

export function startedByPath(): string {
  return join(configDir(), "started-by.json");
}

export function startedByKey(item: StartedBy): string {
  return `${item.agent}\0${item.sessionId}`;
}

function chat(value: unknown): StartedBy | undefined {
  const item = value as Record<string, unknown> | null;
  return item && lineageAgent(item.agent) && typeof item.sessionId === "string" && SESSION_ID.test(item.sessionId)
    ? { agent: item.agent, sessionId: item.sessionId } : undefined;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function validLink(value: unknown): StartedByLink | undefined {
  const item = value as Record<string, unknown> | null;
  const child = chat(item);
  const parent = chat(item?.parent);
  if (!item || !child || !parent || startedByKey(child) === startedByKey(parent)) return undefined;
  if ((item.source !== "process" && item.source !== "transcript") || !finite(item.at)) return undefined;
  return { ...child, parent, source: item.source, at: item.at };
}

function validRun(value: unknown): StartedRun | undefined {
  const item = value as Record<string, unknown> | null;
  const parent = chat(item?.parent);
  if (!item || !parent || !lineageAgent(item.agent) || !Number.isSafeInteger(item.pid)) return undefined;
  if (!finite(item.startedAt) || !finite(item.capturedAt)) return undefined;
  const folder = typeof item.folder === "string" && item.folder.length <= 1_024 ? item.folder : undefined;
  const sessionId = typeof item.sessionId === "string" && SESSION_ID.test(item.sessionId) ? item.sessionId : undefined;
  if (!folder && !sessionId) return undefined;
  return { agent: item.agent, pid: item.pid as number, startedAt: item.startedAt, ...(folder ? { folder } : {}),
    ...(sessionId ? { sessionId } : {}), parent, capturedAt: item.capturedAt };
}

export type StartedByState = { links: Map<string, StartedByLink>; runs: StartedRun[] };

let cached: { path: string; stamp: string; state: StartedByState } | undefined;

function stampOf(path: string): string | undefined {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
}

/** What is known, read again only when the file changed. */
export function startedByState(): StartedByState {
  const path = startedByPath();
  const stamp = stampOf(path);
  if (!stamp) return { links: new Map(), runs: [] };
  if (cached?.path === path && cached.stamp === stamp) return cached.state;
  const state: StartedByState = { links: new Map(), runs: [] };
  try {
    const stored = JSON.parse(readFileSync(path, "utf8")) as { links?: unknown; runs?: unknown };
    for (const value of Array.isArray(stored.links) ? stored.links : []) {
      const link = validLink(value);
      if (link) state.links.set(startedByKey(link), link);
    }
    for (const value of Array.isArray(stored.runs) ? stored.runs : []) {
      const run = validRun(value);
      if (run) state.runs.push(run);
    }
  } catch {
    // A file that cannot be read holds nothing; the next capture rewrites it.
  }
  cached = { path, stamp, state };
  return state;
}

/** The chat that started this one, when it is known. */
export function startedByLink(child: StartedBy): StartedByLink | undefined {
  return startedByState().links.get(startedByKey(child));
}

const childIds = new WeakMap<StartedByState, ReadonlySet<string>>();

/** Every session known to have been started by another chat, by session id alone. */
export function startedChildSessionIds(): ReadonlySet<string> {
  const state = startedByState();
  let ids = childIds.get(state);
  if (!ids) childIds.set(state, ids = new Set([...state.links.values()].map((link) => link.sessionId)));
  return ids;
}

const sameRun = (left: StartedRun, right: StartedRun) => left.agent === right.agent && left.pid === right.pid
  && Math.abs(left.startedAt - right.startedAt) <= 2_000;

function write(state: StartedByState, now: number): void {
  const links = [...state.links.values()].filter((link) => link.at >= now - HISTORY_RETENTION_MS)
    .sort((left, right) => left.at - right.at).slice(-MAX_LINKS);
  const runs = state.runs.filter((run) => run.capturedAt >= now - RUN_TTL_MS)
    .sort((left, right) => left.capturedAt - right.capturedAt).slice(-MAX_RUNS);
  const path = startedByPath();
  writePrivateFile(path, JSON.stringify({ version: 1, links, runs }));
  const stamp = stampOf(path);
  cached = stamp ? { path, stamp, state: { links: new Map(links.map((link) => [startedByKey(link), link])), runs } } : undefined;
}

/** Keep runs a process sample named a parent for. Returns how many were new. */
export function rememberStartedRuns(captured: readonly StartedRun[], now = Date.now()): number {
  const state = startedByState();
  const fresh = captured.flatMap((value) => validRun(value) ?? [])
    .filter((run, index, all) => !state.runs.some((known) => sameRun(known, run))
      && all.findIndex((other) => sameRun(other, run)) === index);
  if (fresh.length === 0) return 0;
  write({ links: new Map(state.links), runs: [...state.runs, ...fresh] }, now);
  return fresh.length;
}

/**
 * Write links down and let go of the runs they came from. The first link of a chat stands, except
 * that a link its own process named replaces one read from a transcript. Returns how many changed.
 */
export function rememberStartedLinks(found: readonly StartedByLink[], consumed: readonly StartedRun[] = [],
  now = Date.now()): number {
  const state = startedByState();
  const links = new Map(state.links);
  let changed = 0;
  for (const value of found) {
    const link = validLink(value);
    const known = link ? links.get(startedByKey(link)) : undefined;
    if (!link || (known && !(known.source === "transcript" && link.source === "process"))) continue;
    if (known && startedByKey(known.parent) === startedByKey(link.parent)) continue;
    links.set(startedByKey(link), link);
    changed += 1;
  }
  const runs = state.runs.filter((run) => !consumed.some((used) => sameRun(used, run)));
  if (changed === 0 && runs.length === state.runs.length) return 0;
  write({ links, runs }, now);
  return changed;
}
