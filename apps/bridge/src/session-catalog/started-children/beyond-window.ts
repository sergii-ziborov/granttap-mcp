/**
 * Runs another chat started that the catalog's window no longer reads.
 *
 * A catalog reads each provider's newest 200 transcripts, so a script that starts hundreds of
 * `codex exec` runs pushes its earlier ones out within the hour: they were never linked to the chat
 * that started them, never counted on it, and a phone that had them as chats kept them as chats of
 * their own. At most once a minute, on the leading monitor, this pass reads the Codex rollouts just
 * beyond the window that are no more than two days old and not yet written down, links each headless
 * one by the same rules as the catalog (`started-by`: its request, else its folder, against the
 * chats the last catalog read), and writes down how each linked run ended (`ledger.ts`). A rollout
 * whose run is written down is skipped by its file name, without being read; one read before is read
 * again only when it changed. Requests and answers are not kept.
 */
import { statSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { parseCodexFile } from "../../sessions/scan/codex";
import { codexSessionsRoot, MAX_FILES, recentLogs } from "../../sessions/support/common";
import { providerScanEnabled } from "../../sessions/provider-discovery";
import { startedByKey, startedByParents, TRANSCRIPT_MATCH_MS, type LineageFact } from "../../started-by";
import { countedRun, countedRuns, countStartedRuns, type CountedRun } from "./ledger";

/** How many rollouts beyond the window one pass looks at, newest first. */
export const BEYOND_WINDOW_FILES = 2_000;
const PASS_EVERY_MS = 60_000;
/** A rollout file names its session: `rollout-<time>-<uuid>.jsonl`. */
const ROLLOUT_ID = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

type Read = { mtimeMs: number; size: number; fact?: LineageFact; run?: CountedRun };

let parents: LineageFact[] = [];
const reads = new Map<string, Read>();
let running: Promise<number> | undefined;
let lastPassAt = 0;

/** The chats the last catalog read that ran commands: the only ones a run can be linked to. */
export function noteCatalogParents(facts: readonly LineageFact[]): void {
  parents = facts.filter((fact) => fact.calls?.length || fact.launches?.length);
}

/** One rollout's lineage and outcome: from the last read when the file has not changed. */
function readRollout(file: string, mtimeMs: number, size: number): Read {
  const known = reads.get(file);
  if (known && known.mtimeMs === mtimeMs && known.size === size) return known;
  const candidate = parseCodexFile(file);
  const fact = candidate && !candidate.child && candidate.lineage?.headless
    && (candidate.requested !== false || candidate.session.summary) ? candidate.lineage : undefined;
  const read: Read = { mtimeMs, size, fact,
    run: fact && candidate ? countedRun(candidate.session, Boolean(candidate.pictures?.length)) : undefined };
  reads.set(file, read);
  return read;
}

type PassOptions = { now?: number; window?: number; depth?: number };

async function pass({ now = Date.now(), window = MAX_FILES, depth = BEYOND_WINDOW_FILES }: PassOptions): Promise<number> {
  if (parents.length === 0 || !providerScanEnabled("codex")) return 0;
  const files = recentLogs(codexSessionsRoot(), 5, window + depth).slice(window);
  const counted = countedRuns();
  const seen = new Set<string>();
  const found: Read[] = [];
  for (const [index, file] of files.entries()) {
    if (index % 16 === 15) await setImmediate();
    const id = ROLLOUT_ID.exec(file)?.[1];
    if (id && counted.has(id)) continue;
    let stat;
    try { stat = statSync(file); } catch { continue; }
    // Newest first: past two days no run can be linked from a transcript any more.
    if (now - stat.mtimeMs > TRANSCRIPT_MATCH_MS) break;
    seen.add(file);
    const read = readRollout(file, stat.mtimeMs, stat.size);
    if (read.fact) found.push(read);
  }
  for (const file of reads.keys()) if (!seen.has(file)) reads.delete(file);
  if (found.length === 0) return 0;
  const links = startedByParents([...parents, ...found.map((read) => read.fact!)], now);
  return countStartedRuns(found.flatMap(({ fact, run }) => {
    const link = run ? links.get(startedByKey(fact!)) : undefined;
    return link ? [{ parent: link.parent, run: run! }] : [];
  }), now);
}

/**
 * Link and count the runs beyond the window. Single-flight, and at most once a minute unless `force`.
 * Returns how many runs were newly written down.
 */
export function settleRunsBeyondWindow(options: PassOptions & { force?: boolean } = {}): Promise<number> {
  const now = options.now ?? Date.now();
  if (running) return running;
  if (!options.force && now - lastPassAt < PASS_EVERY_MS && now >= lastPassAt) return Promise.resolve(0);
  lastPassAt = now;
  running = pass({ ...options, now }).finally(() => { running = undefined; });
  return running;
}

/** For tests: forget what was read and when the last pass ran. */
export function forgetBeyondWindow(): void {
  parents = [];
  reads.clear();
  lastPassAt = 0;
}
