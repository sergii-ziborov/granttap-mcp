import type { ActivityEntry, SessionActivity, SessionInfo } from "../../../../packages/protocol/schema";
import { appendCodexActivity, codexCapabilityUsage } from "../sessions/scan/codex/activity";
import { codexLogLines, codexLogPathForSession } from "../sessions/scan/codex/shared";
import { appendClaudeActivity, claudeCapabilityUsage, claudeLogPath } from "../sessions/scan/claude";
import { previousNativeLines } from "./native-lines";
import { recordedFileChanges } from "./changes";
import { recordedToolDetails } from "./tool-details";
import { completedTurnChanges } from "./turn-changes";
export { nativeImageLines } from "./images";
export { nativeTranscriptImage } from './images/native';

function boundedEntry(entry: ActivityEntry): ActivityEntry {
  const result = { ...entry };
  if (!entry.fileChanges) return result;
  result.fileChanges = [];
  let bytes = 0;
  for (const file of entry.fileChanges) {
    const preview = { ...file, diff: file.diff.slice(0, 2048),
      diffTruncated: file.diffTruncated || file.diff.length > 2048 };
    bytes += Buffer.byteLength(JSON.stringify(preview));
    if (bytes > 128 * 1024) { result.fileChangesComplete = false; break; }
    result.fileChanges.push(preview);
  }
  return result;
}

/** Native root-chat pages. New live entries do not move a saved older cursor. */
export function readTranscriptHistory(session: SessionInfo, cursor?: string): SessionActivity | undefined {
  if (session.agent !== "codex" && session.agent !== "claude") return undefined;
  let path = session.agent === "claude" ? claudeLogPath(session.sessionId)
    : codexLogPathForSession(session.sessionId, session.startedAt);
  if (!path && session.agent === "codex") {
    codexLogLines(session.sessionId);
    path = codexLogPathForSession(session.sessionId, session.startedAt);
  }
  if (!path) return undefined;
  let window;
  try { window = previousNativeLines(path, session.sessionId, cursor); } catch { return undefined; }
  if (!window) return undefined;
  const lines = window.lines.map((line) => line.text);
  const usage = session.agent === "claude" ? claudeCapabilityUsage(session, lines) : codexCapabilityUsage(session, lines);
  const observations = new Map(usage.map((item) => [item.sourceId, item]));
  const out: ActivityEntry[] = [];
  const seen = new Set<string>();
  const changes = recordedFileChanges(lines);
  const details = recordedToolDetails(lines);
  const offsets = new Map<string, number>();
  for (const line of window.lines) {
    const before = out.length;
    if (session.agent === "claude") {
      appendClaudeActivity({ out, seen, session, lines: [line.text], observations, fullText: true });
    } else {
      appendCodexActivity({ out, seen, session, lines: [line.text], observations, changes, details, fullText: true });
    }
    for (const entry of out.slice(before)) offsets.set(entry.id, line.offset);
  }
  let from = Math.max(0, out.length - 40);
  // Include the question above the first answer, without loading an unbounded turn.
  while (from > Math.max(0, out.length - 80) && out[from]?.kind !== "user") from--;
  let entries = out.slice(from);
  for (const entry of entries) {
    if (entry.kind !== "final") continue;
    const summary = completedTurnChanges(path, session.sessionId, entry.id, offsets.get(entry.id)!, window.lines);
    entry.fileChanges = summary.files;
    entry.fileChangesComplete = summary.complete;
  }
  let bytes = 0;
  const bounded: ActivityEntry[] = [];
  for (const source of entries.reverse()) {
    // A large patch still appears, with an explicit bounded diff preview.
    const entry = boundedEntry(source);
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (bytes + size > 384 * 1024 && bounded.length > 0) break;
    bytes += size;
    bounded.unshift(entry);
  }
  entries = bounded;
  const offset = entries[0] ? offsets.get(entries[0].id)! : window.start;
  return { type: "session.activity", sessionId: session.sessionId, agent: session.agent,
    state: session.state, entries, generatedAt: Date.now(), history: {
      hasMore: offset > 0, ...(offset > 0 ? { cursor: window.cursorAt(offset) } : {}),
      ...(cursor ? { requestedCursor: cursor } : {}),
    } };
}
