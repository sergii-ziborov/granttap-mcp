import {
  codexActivitySourcesBySession,
  codexAggregatedObservationsBySession,
  codexLogPathBySession,
  codexSummaryCache,
  type CodexCandidate,
} from "./shared";
import { parseCodexFile } from "./parse";
import { assembleCodexScan } from "./assemble";
import { recentLogs, codexSessionsRoot, MAX_FILES, type Scan } from "../../support/common";

export function scanCodex(maxFiles = MAX_FILES): Scan {
  const root = codexSessionsRoot();
  const listed = recentLogs(root, 5, maxFiles + 1);
  const files = listed.slice(0, maxFiles);
  const activeFiles = new Set(files);
  const seenSessionIds = new Set<string>();
  const candidates: CodexCandidate[] = [];
  codexLogPathBySession.clear();
  codexActivitySourcesBySession.clear();
  codexAggregatedObservationsBySession.clear();

  for (const file of files) {
    const candidate = parseCodexFile(file);
    if (!candidate || seenSessionIds.has(candidate.session.sessionId)) continue;
    seenSessionIds.add(candidate.session.sessionId);
    candidates.push(candidate);
  }
  for (const file of codexSummaryCache.keys()) {
    if (!activeFiles.has(file)) codexSummaryCache.delete(file);
  }
  return { ...assembleCodexScan(candidates), sourceLimited: listed.length > maxFiles };
}
