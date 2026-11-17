/**
 * Name, on each chat another chat started, the chat that started it (`startedBy`).
 *
 * Three sources, in this order: a link already written down; a run a process sample captured, joined
 * to the session it started by provider, folder and start time (or by the id its command gave it);
 * and, for a run whose process was never seen, the parent's transcript: a command that starts the
 * child's provider headless, that carries the opening of the child's first request, and that was
 * running when the child started, on the same computer; failing that, the one chat that started the
 * child's provider headless naming the child's own folder (`folders/`). A child that more than one chat
 * could have started is left unlinked. A session never names itself, and a link that would close a loop
 * is not made.
 */
import type { SessionInfo } from "../../../../packages/protocol/schema";
import { plainFolder } from "../helper-runs/kinds";
import type { LineageFact } from "./facts";
import { folderParents } from "./folders";
import {
  rememberStartedLinks,
  startedByKey,
  startedByState,
  type StartedBy,
  type StartedByLink,
  type StartedRun,
} from "./links";

/** A session starts within this long of its process; its first record waits for the provider to load. */
const RUN_BEFORE_MS = 5_000;
const RUN_AFTER_MS = 120_000;
/** A child starts after its parent's command was issued, and its first record can trail the command's end. */
const CALL_BEFORE_MS = 3_000;
const CALL_AFTER_MS = 10_000;
/** A command the transcript never saw end is taken to have run for at most this long. */
const OPEN_CALL_MS = 6 * 60 * 60_000;
/** Only children started this recently are matched against transcripts. */
export const TRANSCRIPT_MATCH_MS = 48 * 60 * 60_000;

function sameFolder(left: string | undefined, right: string | undefined): boolean {
  return !!left && !!right && plainFolder(left) === plainFolder(right);
}

/** Each captured run joined to at most one session, nearest start first. */
function joinRuns(facts: readonly LineageFact[], runs: readonly StartedRun[]) {
  const pairs: Array<{ fact: LineageFact; run: StartedRun; distance: number }> = [];
  for (const fact of facts) {
    if (!fact.headless) continue;
    for (const run of runs) {
      if (run.agent !== fact.agent) continue;
      if (run.sessionId) {
        if (run.sessionId === fact.sessionId) pairs.push({ fact, run, distance: -1 });
        continue;
      }
      const distance = fact.startedAt - run.startedAt;
      if (sameFolder(run.folder, fact.cwd) && distance >= -RUN_BEFORE_MS && distance <= RUN_AFTER_MS) {
        pairs.push({ fact, run, distance: Math.abs(distance) });
      }
    }
  }
  const joinedFacts = new Set<LineageFact>();
  const joinedRuns = new Set<StartedRun>();
  const joined: Array<{ fact: LineageFact; run: StartedRun }> = [];
  for (const pair of pairs.sort((left, right) => left.distance - right.distance)) {
    if (joinedFacts.has(pair.fact) || joinedRuns.has(pair.run)) continue;
    joinedFacts.add(pair.fact);
    joinedRuns.add(pair.run);
    joined.push(pair);
  }
  return joined;
}

/** The one chat whose transcript shows it starting this child, or none. */
export function transcriptParent(child: LineageFact, facts: readonly LineageFact[], now = Date.now()): StartedBy | undefined {
  const prompt = child.prompt;
  if (!child.headless || !prompt || now - child.startedAt > TRANSCRIPT_MATCH_MS) return undefined;
  const parents = new Map<string, StartedBy>();
  for (const parent of facts) {
    if (!parent.calls?.length || startedByKey(parent) === startedByKey(child)) continue;
    if ((parent.computerId ?? "") !== (child.computerId ?? "") || parent.startedAt > child.startedAt) continue;
    for (const call of parent.calls) {
      const end = call.endedAt ?? Math.min(now, call.startedAt + OPEN_CALL_MS);
      if (!call.targets.includes(child.agent) || child.startedAt < call.startedAt - CALL_BEFORE_MS
        || child.startedAt > end + CALL_AFTER_MS || !call.command.includes(prompt.lead)) continue;
      parents.set(startedByKey(parent), { agent: parent.agent, sessionId: parent.sessionId });
    }
  }
  return parents.size === 1 ? [...parents.values()][0] : undefined;
}

/** Whether linking `child` to `parent` would make the child its own ancestor. */
function closesLoop(child: StartedBy, parent: StartedBy, links: ReadonlyMap<string, StartedByLink>): boolean {
  let current: StartedBy | undefined = parent;
  for (let depth = 0; current && depth < 16; depth += 1) {
    if (startedByKey(current) === startedByKey(child)) return true;
    current = links.get(startedByKey(current))?.parent;
  }
  return false;
}

/** The parent of every session the catalog can name one for, writing new links down. */
export function startedByParents(facts: readonly LineageFact[], now = Date.now()): ReadonlyMap<string, StartedByLink> {
  const state = startedByState();
  const links = new Map(state.links);
  const found: StartedByLink[] = [];
  const consumed: StartedRun[] = [];
  const add = (fact: LineageFact, parent: StartedBy, source: StartedByLink["source"]) => {
    if (startedByKey(parent) === startedByKey(fact) || closesLoop(fact, parent, links)) return;
    const link: StartedByLink = { agent: fact.agent, sessionId: fact.sessionId, parent, source, at: now };
    links.set(startedByKey(fact), link);
    found.push(link);
  };
  for (const { fact, run } of joinRuns(facts, state.runs)) {
    consumed.push(run);
    // The first run its process named stands; it replaces a link read from a transcript.
    const known = links.get(startedByKey(fact));
    if (!known || (known.source === "transcript" && startedByKey(known.parent) !== startedByKey(run.parent))) {
      add(fact, run.parent, "process");
    }
  }
  const byFolder = folderParents(facts, now);
  for (const fact of facts) {
    if (links.has(startedByKey(fact))) continue;
    const parent = transcriptParent(fact, facts, now)
      ?? (now - fact.startedAt <= TRANSCRIPT_MATCH_MS ? byFolder(fact) : undefined);
    if (parent) add(fact, parent, "transcript");
  }
  if (found.length > 0 || consumed.length > 0) {
    try { rememberStartedLinks(found, consumed, now); } catch { /* Found again by the next catalog. */ }
  }
  return links;
}

/** Each session with the chat that started it, when one is known. */
export function attachStartedBy(sessions: SessionInfo[], facts: readonly LineageFact[], now = Date.now()): SessionInfo[] {
  let links: ReadonlyMap<string, StartedByLink>;
  try { links = startedByParents(facts, now); } catch { return sessions; }
  if (links.size === 0) return sessions;
  return sessions.map((session) => {
    const link = links.get(`${session.agent}\0${session.sessionId}`);
    if (!link || link.parent.sessionId === session.sessionId) return session;
    return { ...session, startedBy: { agent: link.parent.agent, sessionId: link.parent.sessionId } };
  });
}
