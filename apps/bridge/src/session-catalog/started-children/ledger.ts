/**
 * What each run another chat started came to, kept after the run leaves the catalog's window.
 *
 * The catalog reads the newest 200 transcripts of each provider. A chat whose script starts nine
 * hundred `codex exec` runs in a day has most of them outside that window within hours, so counting
 * only what the window holds said "200 of 200 stopped" about a script whose earlier runs had made
 * hundreds of pictures. Each finished run is written down here once, by the chat that started it:
 * how it ended (answered, stopped by a usage or rate limit, stopped on another error), whether it
 * saved a picture, and when. Only ids, an outcome letter and a time are kept (`started-runs.json`).
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SessionInfo } from "../../../../../packages/protocol/schema";
import { writePrivateFile } from "../../config/access/write-private";
import { configDir } from "../../config/runtime/paths";
import { HISTORY_RETENTION_MS } from "../../sessions/support/common";
import { lineageAgent, SESSION_ID, startedByKey, type StartedBy } from "../../started-by";

export type RunEnd = "answered" | "limit" | "error";

/** One finished run: its session id, how it ended, whether it saved a picture, and when it last moved. */
export type CountedRun = { sessionId: string; end: RunEnd; picture: boolean; at: number };

/** At most this many runs are kept across every chat, the oldest let go first. */
export const MAX_COUNTED_RUNS = 20_000;

const CODES: Record<RunEnd, string> = { answered: "a", limit: "l", error: "e" };
const ENDS: Record<string, RunEnd> = { a: "answered", l: "limit", e: "error" };

type Ledger = { parents: Map<string, { parent: StartedBy; runs: Map<string, CountedRun> }>; owner: Map<string, string> };

export function startedRunsPath(): string {
  return join(configDir(), "started-runs.json");
}

/** How a finished session ended, or nothing while it still works. */
export function countedRun(session: SessionInfo, picture = false): CountedRun | undefined {
  if (session.state !== "idle" || !SESSION_ID.test(session.sessionId)) return undefined;
  const reason = session.stopped?.reason;
  // As the phone reads a run: a usage or rate limit, or a limit the provider still reports, is a limit.
  const limited = reason === "usage_limit" || reason === "rate_limit" || (!reason && Boolean(session.usageLimit));
  const end: RunEnd = limited ? "limit" : reason ? "error" : "answered";
  return { sessionId: session.sessionId, end, picture: picture || Boolean(session.images?.length), at: session.lastActivityAt };
}

let cached: { path: string; stamp: string; ledger: Ledger } | undefined;

function stampOf(path: string): string | undefined {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
}

function emptyLedger(): Ledger {
  return { parents: new Map(), owner: new Map() };
}

function add(ledger: Ledger, parent: StartedBy, run: CountedRun): void {
  const key = startedByKey(parent);
  const entry = ledger.parents.get(key) ?? { parent, runs: new Map<string, CountedRun>() };
  const previous = ledger.owner.get(run.sessionId);
  if (previous && previous !== key) ledger.parents.get(previous)?.runs.delete(run.sessionId);
  entry.runs.set(run.sessionId, run);
  ledger.parents.set(key, entry);
  ledger.owner.set(run.sessionId, key);
}

function parse(text: string): Ledger {
  const ledger = emptyLedger();
  const stored = JSON.parse(text) as { parents?: unknown };
  for (const value of Array.isArray(stored.parents) ? stored.parents : []) {
    const item = value as { agent?: unknown; sessionId?: unknown; runs?: unknown } | null;
    if (!item || !lineageAgent(item.agent) || typeof item.sessionId !== "string" || !SESSION_ID.test(item.sessionId)) continue;
    const parent: StartedBy = { agent: item.agent, sessionId: item.sessionId };
    for (const row of Array.isArray(item.runs) ? item.runs : []) {
      const [sessionId, code, at] = Array.isArray(row) ? row : [];
      const end = typeof code === "string" ? ENDS[code[0] ?? ""] : undefined;
      if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId) || !end || typeof at !== "number" || !Number.isFinite(at)) continue;
      if (sessionId === parent.sessionId) continue;
      add(ledger, parent, { sessionId, end, picture: (code as string).endsWith("p"), at });
    }
  }
  return ledger;
}

/** What is known, read again only when the file changed. */
function ledgerState(): Ledger {
  const path = startedRunsPath();
  const stamp = stampOf(path);
  if (!stamp) return emptyLedger();
  if (cached?.path === path && cached.stamp === stamp) return cached.ledger;
  let ledger = emptyLedger();
  try { ledger = parse(readFileSync(path, "utf8")); } catch { /* Unreadable: counted again from the transcripts. */ }
  cached = { path, stamp, ledger };
  return ledger;
}

function write(ledger: Ledger, now: number): void {
  const runs = [...ledger.parents.values()].flatMap(({ parent, runs }) => [...runs.values()].map((run) => ({ parent, run })))
    .filter(({ run }) => run.at >= now - HISTORY_RETENTION_MS)
    .sort((left, right) => left.run.at - right.run.at).slice(-MAX_COUNTED_RUNS);
  const kept = emptyLedger();
  for (const { parent, run } of runs) add(kept, parent, run);
  const parents = [...kept.parents.values()].map(({ parent, runs }) => ({ ...parent,
    runs: [...runs.values()].map((run) => [run.sessionId, `${CODES[run.end]}${run.picture ? "p" : ""}`, run.at]) }));
  const path = startedRunsPath();
  writePrivateFile(path, JSON.stringify({ version: 1, parents }));
  const stamp = stampOf(path);
  cached = stamp ? { path, stamp, ledger: kept } : undefined;
}

const same = (left: CountedRun | undefined, right: CountedRun) => left?.end === right.end
  && left.picture === right.picture && left.at === right.at;

/** Write down finished runs and the chat that started each. Returns how many were new or changed. */
export function countStartedRuns(found: ReadonlyArray<{ parent: StartedBy; run: CountedRun }>, now = Date.now()): number {
  const current = ledgerState();
  const changed = found.filter(({ parent, run }) => run.sessionId !== parent.sessionId
    && (current.owner.get(run.sessionId) !== startedByKey(parent)
      || !same(current.parents.get(startedByKey(parent))?.runs.get(run.sessionId), run)));
  if (changed.length === 0) return 0;
  const next = emptyLedger();
  for (const { parent, runs } of current.parents.values()) for (const run of runs.values()) add(next, parent, run);
  for (const { parent, run } of changed) add(next, parent, run);
  write(next, now);
  return changed.length;
}

/** The runs written down now, one reading for a whole list: each chat's, and whether a run is among them. */
export function countedRuns(): { of: (parent: StartedBy) => ReadonlyMap<string, CountedRun>; has: (sessionId: string) => boolean } {
  let ledger: Ledger;
  try { ledger = ledgerState(); } catch { ledger = emptyLedger(); }
  return { of: (parent) => ledger.parents.get(startedByKey(parent))?.runs ?? new Map(),
    has: (sessionId) => ledger.owner.has(sessionId) };
}
