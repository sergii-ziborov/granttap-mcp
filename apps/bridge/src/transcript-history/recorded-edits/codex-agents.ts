import { statSync } from 'node:fs';
import type { ActivityEntry, ChildThreadInfo, SessionInfo } from '../../../../../packages/protocol/schema';
import { appendCodexActivity } from '../../sessions/scan/codex/activity/rows';
import { CODEX_ACTIVITY_HEAD_BYTES, CODEX_ACTIVITY_TAIL_BYTES, codexActivitySourcesBySession,
  readCodexLogWindow } from '../../sessions/scan/codex/shared';
import { recordedFileChanges, type RecordedFileChange } from '../changes';
import { mergeChange } from './claude-agents';
import { withFolder } from './folders';

type ChildEdits = { mtimeMs: number; size: number; edits: { at: number; files: RecordedFileChange[] }[] };
const children = new Map<string, ChildEdits>();

/** A child rollout's completed edits with their times; read again only when the file changes. */
function childEdits(path: string, session: SessionInfo, child: ChildThreadInfo): ChildEdits['edits'] {
  let stat;
  try { stat = statSync(path); } catch { children.delete(path); return []; }
  const known = children.get(path);
  if (known?.mtimeMs === stat.mtimeMs && known.size === stat.size) return known.edits;
  const lines = readCodexLogWindow(path, CODEX_ACTIVITY_HEAD_BYTES, CODEX_ACTIVITY_TAIL_BYTES);
  const out: ActivityEntry[] = [];
  appendCodexActivity({ out, seen: new Set(), session, lines, observations: new Map(), child,
    changes: recordedFileChanges(lines) });
  const edits = out.flatMap(entry => entry.fileChanges?.length ? [{ at: entry.createdAt, files: entry.fileChanges }] : []);
  children.delete(path);
  children.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, edits });
  while (children.size > 128) children.delete(children.keys().next().value!);
  return edits;
}

/**
 * Codex records a nested agent as its own rollout with no link to the call
 * that started it, so a reply owns the agent edits completed during its turn.
 */
export function codexAgentChanges(session: SessionInfo, from: number, to: number): RecordedFileChange[] {
  const files = new Map<string, RecordedFileChange>();
  for (const { path, child } of codexActivitySourcesBySession.get(session.sessionId) ?? []) {
    if (!child) continue;
    const agentTitle = child.title ?? child.agentName;
    for (const edit of childEdits(path, session, child)) {
      if (edit.at < from || edit.at > to) continue;
      for (const file of edit.files) {
        const key = `${child.threadId}\0${file.path}`;
        files.set(key, mergeChange(files.get(key), withFolder({ ...file, agentThreadId: child.threadId,
          ...(agentTitle ? { agentTitle } : {}) })));
      }
    }
  }
  return [...files.values()];
}
