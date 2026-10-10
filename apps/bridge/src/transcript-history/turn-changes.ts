import { safeParse } from "../sessions/support/common";
import { nativeChanges, recordedFileChanges, type RecordedFileChange } from "./changes";
import { nativeHistoryCursor, previousNativeLines, type NativeLine } from "./native-lines";

type Summary = { files: RecordedFileChange[]; complete: boolean };
const summaries = new Map<string, Summary>();

function collectFiles(edits: RecordedFileChange[]): Summary {
  const byPath = new Map<string, RecordedFileChange>();
  for (const edit of edits) {
    const previous = byPath.get(edit.path);
    const diff = previous ? `${previous.diff}\n${edit.diff}` : edit.diff;
    byPath.set(edit.path, { path: edit.path,
      linesAdded: (previous?.linesAdded ?? 0) + edit.linesAdded,
      linesRemoved: (previous?.linesRemoved ?? 0) + edit.linesRemoved,
      diff: diff.slice(0, 2048),
      diffTruncated: previous?.diffTruncated || edit.diffTruncated || diff.length > 2048 });
  }
  return { files: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)).slice(0, 64),
    complete: byPath.size <= 64 };
}

/** A completed reply's native edits, including rows outside its visible page. */
export function completedTurnChanges(path: string, sessionId: string, finalId: string,
  finalOffset: number, pageLines: NativeLine[]): Summary {
  const key = `${path}\0${sessionId}\0${finalId}`;
  const cached = summaries.get(key);
  if (cached) return cached;
  let turnId: string | undefined;
  for (const line of pageLines) {
    if (line.offset > finalOffset) break;
    const row = safeParse(line.text);
    if (typeof row?.payload?.turn_id === "string") turnId = row.payload.turn_id;
  }
  const native = new Map<string, RecordedFileChange[]>();
  const legacy: string[] = [];
  let legacyBytes = 0, complete = false, bounded = false;
  let cursor = nativeHistoryCursor(path, sessionId, finalOffset);
  for (let page = 0; page < 32 && cursor; page++) {
    const window = previousNativeLines(path, sessionId, cursor);
    if (!window) break;
    for (const line of [...window.lines].reverse()) {
      const row = safeParse(line.text), p = row?.payload;
      if (!p) continue;
      if (turnId && (p.type === "task_started" && p.turn_id === turnId
        || row.type === "turn_context" && p.turn_id && p.turn_id !== turnId)
        || !turnId && (p.type === "user_message" || p.type === "message" && p.role === "user")) {
        complete = true;
        break;
      }
      if (p.type === "item_completed" && (!turnId || p.turn_id === turnId)) {
        const files = nativeChanges(p.item);
        if (files.length) native.set(p.item.id, files);
      }
      if (row.type === "response_item" && p.call_id) {
        legacyBytes += Buffer.byteLength(line.text);
        if (legacyBytes <= 8 * 1024 * 1024) legacy.unshift(line.text);
        else bounded = true;
      }
    }
    if (complete || window.start === 0) { complete = true; break; }
    cursor = window.cursorAt(window.lines[0]?.offset ?? window.start);
  }
  const edits = native.size ? [...native.values()].reverse().flat()
    : [...recordedFileChanges(legacy).values()].flat();
  const summary = collectFiles(edits);
  summary.complete &&= complete && (!bounded || native.size > 0);
  summaries.set(key, summary);
  if (summaries.size > 64) summaries.delete(summaries.keys().next().value!);
  return summary;
}
