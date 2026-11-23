import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { SessionInfo } from '../../../../../packages/protocol/schema';
import { safeParse } from '../../sessions/support/common';
import { claudeChildLogPaths, claudeChildLogPathsBySession, claudeLogPath } from '../../sessions/scan/claude/shared';
import type { RecordedFileChange } from '../changes';
import { createClaudeCallReader } from './claude-calls';

export const MAX_LISTED_FILES = 64;
export const MAX_LISTED_DIFF = 2048;
export type ListedChanges = { files: RecordedFileChange[]; complete: boolean };

/** What one agent's transcript recorded so far; only appended bytes are read again. */
type AgentLog = {
  ino: number; offset: number; carry: string; decoder: StringDecoder; read: (row: any) => void;
  files: Map<string, RecordedFileChange>; overflow: boolean;
  launches: Map<string, string | undefined>; agents: Map<string, string>;
};
const logs = new Map<string, AgentLog>();
const metas = new Map<string, { mtimeMs: number; call?: string }>();

/** Successive edits of one file read as one row, its diff bounded like a reply's summary. */
export function mergeChange(previous: RecordedFileChange | undefined, edit: RecordedFileChange): RecordedFileChange {
  const diff = previous ? `${previous.diff}\n${edit.diff}` : edit.diff;
  return { ...previous, ...edit, linesAdded: (previous?.linesAdded ?? 0) + edit.linesAdded,
    linesRemoved: (previous?.linesRemoved ?? 0) + edit.linesRemoved, diff: diff.slice(0, MAX_LISTED_DIFF),
    ...(previous?.diffTruncated || edit.diffTruncated || diff.length > MAX_LISTED_DIFF ? { diffTruncated: true } : {}) };
}

function freshLog(ino: number): AgentLog {
  const log: AgentLog = { ino, offset: 0, carry: '', decoder: new StringDecoder('utf8'), read: () => {},
    files: new Map(), overflow: false, launches: new Map(), agents: new Map() };
  log.read = createClaudeCallReader({
    edit: (_, change) => {
      const previous = log.files.get(change.path);
      if (!previous && log.files.size >= MAX_LISTED_FILES) { log.overflow = true; return; }
      log.files.set(change.path, mergeChange(previous, change));
    },
    launch: (call, description) => log.launches.set(call, description),
    agent: (call, agentId) => log.agents.set(call, agentId),
  });
  return log;
}

function agentLog(path: string): AgentLog | undefined {
  let stat;
  try { stat = statSync(path); } catch { logs.delete(path); return undefined; }
  let log = logs.get(path);
  if (!log || log.ino !== stat.ino || stat.size < log.offset) log = freshLog(stat.ino);
  if (stat.size > log.offset) {
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.allocUnsafe(1 << 20);
      while (log.offset < stat.size) {
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - log.offset), log.offset);
        if (!count) break;
        log.offset += count;
        const lines = (log.carry + log.decoder.write(buffer.subarray(0, count))).split('\n');
        log.carry = lines.pop() ?? '';
        for (const line of lines) if (line.includes('"tool_')) log.read(safeParse(line));
      }
    } finally { closeSync(fd); }
  }
  logs.delete(path);
  logs.set(path, log);
  while (logs.size > 128) logs.delete(logs.keys().next().value!);
  return log;
}

/** The call an older agent was started by, from the small file Claude Code writes beside it. */
function metaCall(path: string): string | undefined {
  const file = path.replace(/\.jsonl$/, '.meta.json');
  let stat;
  try { stat = statSync(file); } catch { return undefined; }
  const known = metas.get(file);
  if (known?.mtimeMs === stat.mtimeMs) return known.call;
  let call: string | undefined;
  try {
    const meta = stat.size <= 64 * 1024 ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
    call = typeof meta?.toolUseId === 'string' ? meta.toolUseId : undefined;
  } catch { /* An unreadable note links nothing. */ }
  metas.set(file, { mtimeMs: stat.mtimeMs, call });
  if (metas.size > 1024) metas.delete(metas.keys().next().value!);
  return call;
}

/**
 * Each root launch's agent edits, including agents those agents started.
 * Only the chat's own listed subagent transcripts are read, and only those a
 * launch in the visible page leads to.
 */
export function claudeAgentChanges(session: SessionInfo, launches: Map<string, string | undefined>,
  links: Map<string, string>): Map<string, ListedChanges> {
  const out = new Map<string, ListedChanges>();
  const parent = launches.size ? claudeLogPath(session.sessionId) : undefined;
  if (!parent) return out;
  const paths = claudeChildLogPathsBySession.get(session.sessionId) ?? claudeChildLogPaths(parent, session.sessionId);
  const byAgent = new Map(paths.map(path => [basename(path, '.jsonl').replace(/^agent-/, ''), path]));
  let byCall: Map<string, string> | undefined;
  const pathFor = (call: string, named: Map<string, string>) => byAgent.get(named.get(call) ?? '')
    ?? (byCall ??= new Map(paths.flatMap(path => { const id = metaCall(path); return id ? [[id, path]] : []; }))).get(call);
  for (const [root, description] of launches) {
    const files: RecordedFileChange[] = [];
    let complete = true;
    const queue = [{ call: root, description, named: links, depth: 0 }];
    const visited = new Set<string>();
    for (let item = queue.shift(); item; item = queue.shift()) {
      const path = pathFor(item.call, item.named);
      const log = path && !visited.has(path) && item.depth < 16 ? agentLog(path) : undefined;
      if (!path || !log) continue;
      visited.add(path);
      const agentThreadId = basename(path, '.jsonl').replace(/^agent-/, '').slice(0, 256);
      const agentTitle = item.description ?? session.childThreads?.find(child => child.threadId === agentThreadId)?.title;
      for (const file of log.files.values()) files.push({ ...file, agentThreadId, ...(agentTitle ? { agentTitle } : {}) });
      complete &&= !log.overflow;
      for (const [call, launched] of log.launches) queue.push({ call, description: launched, named: log.agents, depth: item.depth + 1 });
    }
    if (files.length) out.set(root, listedChanges(files, complete));
  }
  return out;
}

/** At most 64 files per answer row, in path order; a list cut short says so. */
export function listedChanges(files: RecordedFileChange[], complete = true): ListedChanges {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  return { files: sorted.slice(0, MAX_LISTED_FILES), complete: complete && sorted.length <= MAX_LISTED_FILES };
}
