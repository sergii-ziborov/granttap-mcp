import { finishScan, finishScanCooperatively } from "../../cooperative-scan";
import {
  codexActivitySourcesBySession,
  codexAggregatedObservationsBySession,
  codexLogPathBySession,
  codexSummaryCache,
  codexTokenHoursBySession,
  type CodexCandidate,
} from "./shared";
import { parseCodexFile } from "./parse";
import { assembleCodexScan } from "./assemble";
import { recentLogs, codexSessionsRoot, MAX_FILES, type Scan } from "../../support/common";
import { withCheckoutObservationCache } from "../../support/repository-checkout";

export function scanCodex(maxFiles = MAX_FILES): Scan {
  return withCheckoutObservationCache(() => finishScan(scanCodexCatalog(maxFiles)));
}

export function scanCodexCooperatively(maxFiles = MAX_FILES): Promise<Scan> {
  return withCheckoutObservationCache(() => finishScanCooperatively(scanCodexCatalog(maxFiles)));
}

function* scanCodexCatalog(maxFiles: number): Generator<void, Scan> {
  const root = codexSessionsRoot();
  const listed = recentLogs(root, 5, maxFiles + 1);
  const files = listed.slice(0, maxFiles);
  const activeFiles = new Set(files);
  const seenSessionIds = new Set<string>();
  const candidates: CodexCandidate[] = [];
  for (const file of files) {
    yield;
    const candidate = parseCodexFile(file);
    if (!candidate || seenSessionIds.has(candidate.session.sessionId) || requestless(candidate)) continue;
    seenSessionIds.add(candidate.session.sessionId);
    candidates.push(candidate);
  }
  for (const file of codexSummaryCache.keys()) {
    if (!activeFiles.has(file)) codexSummaryCache.delete(file);
  }
  codexLogPathBySession.clear();
  codexActivitySourcesBySession.clear();
  codexAggregatedObservationsBySession.clear();
  codexTokenHoursBySession.clear();
  return { ...assembleCodexScan(candidates), sourceLimited: listed.length > maxFiles,
    lineage: candidates.flatMap((candidate) => candidate.lineage ?? []),
    pictures: candidates.flatMap(({ session, child, pictures }) => !child && session.cwd && pictures?.length
      ? [{ agent: "codex" as const, sessionId: session.sessionId, cwd: session.cwd, at: session.lastActivityAt, pictures }]
      : []) };
}

/**
 * A chat nobody has asked anything yet: no request, no answer. It is no chat on the phone and no Mesh
 * Task until its request appears; a run whose request never came stays out. A forked agent belongs
 * to its parent's chat and is kept.
 */
function requestless(candidate: CodexCandidate): boolean {
  return !candidate.child && candidate.requested === false && !candidate.session.summary;
}
