import type { SessionInfo } from '../../../../../packages/protocol/schema';
import { safeParse } from '../../sessions/support/common';
import type { RecordedFileChange } from '../changes';
import { claudeAgentChanges, listedChanges, mergeChange, type ListedChanges } from './claude-agents';
import { createClaudeCallReader } from './claude-calls';
import { codexAgentChanges } from './codex-agents';
import { withFolder } from './folders';
export { changeFolder } from './folders';
export type { ListedChanges } from './claude-agents';

/**
 * The recorded edits of a Claude page, keyed by the tool call they belong to:
 * each successful Edit, Write or MultiEdit, and for each agent launch every
 * file that agent (or an agent it started) changed.
 */
export function claudeRecordedChanges(session: SessionInfo, lines: readonly string[]): Map<string, ListedChanges> {
  const out = new Map<string, ListedChanges>();
  const launches = new Map<string, string | undefined>(), links = new Map<string, string>();
  const read = createClaudeCallReader({
    edit: (call, change) => out.set(call, { files: [change], complete: true }),
    launch: (call, description) => launches.set(call, description),
    agent: (call, agentId) => links.set(call, agentId),
  });
  for (const line of lines) if (line.includes('"tool_')) read(safeParse(line));
  for (const [call, changes] of claudeAgentChanges(session, launches, links)) out.set(call, changes);
  return out;
}

/** A completed Codex reply's own edits and its agents' edits during the turn, one row per file. */
export function withCodexAgentChanges(session: SessionInfo, reply: { files: RecordedFileChange[]; complete: boolean;
  startedAt?: number }, endedAt: number): ListedChanges {
  const byPath = new Map<string, RecordedFileChange>();
  for (const file of [...reply.files, ...codexAgentChanges(session, reply.startedAt ?? 0, endedAt)]) {
    const previous = byPath.get(file.path);
    byPath.set(file.path, previous ? mergeChange(previous, withFolder(file)) : withFolder(file));
  }
  const listed = listedChanges([...byPath.values()]);
  return { files: listed.files, complete: reply.complete && listed.complete };
}
