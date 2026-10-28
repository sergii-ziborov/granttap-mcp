import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type GrokToolCompletion = { name: string; outcome: string; at: number };
type EventCache = {
  device: number; inode: number; offset: number; modified: number; partial: string;
  calls: Map<string, GrokToolCompletion>;
};
const cache = new Map<string, EventCache>();
const maximumRead = 8 * 1024 * 1024;
const maximumCalls = 2048;

/** Bounded, incremental native metadata only; no tool input, output or reasoning is retained. */
export function grokToolCompletions(directory: string): ReadonlyMap<string, GrokToolCompletion> {
  const path = join(directory, 'events.jsonl');
  let fd: number | undefined;
  try {
    const stat = statSync(path);
    let state = cache.get(path);
    if (!state || state.device !== stat.dev || state.inode !== stat.ino || stat.size < state.offset
        || stat.size === state.offset && stat.mtimeMs !== state.modified) {
      state = { device: stat.dev, inode: stat.ino, offset: Math.max(0, stat.size - maximumRead),
        modified: 0, partial: '', calls: new Map() };
      // The first partial record in a bounded tail cannot establish completion.
      if (state.offset > 0) state.partial = 'discard-prefix';
    }
    if (stat.size === state.offset && stat.mtimeMs === state.modified) return state.calls;
    const bytes = Buffer.alloc(Math.min(maximumRead, stat.size - state.offset));
    fd = openSync(path, 'r');
    const count = readSync(fd, bytes, 0, bytes.length, state.offset);
    const lines = (state.partial + bytes.subarray(0, count).toString('utf8')).split('\n');
    state.partial = (lines.pop() ?? '').slice(0, 16_384);
    for (const line of lines) rememberCompletion(state.calls, line);
    state.offset += count;
    state.modified = stat.mtimeMs;
    cache.delete(path); cache.set(path, state);
    while (cache.size > 32) cache.delete(cache.keys().next().value!);
    return state.calls;
  } catch {
    cache.delete(path);
    return new Map();
  } finally { if (fd !== undefined) closeSync(fd); }
}

function rememberCompletion(calls: Map<string, GrokToolCompletion>, line: string): void {
  if (line.length > 16_384) return;
  let row: Record<string, unknown>;
  try { row = JSON.parse(line); } catch { return; }
  if (!row || row.type !== 'tool_completed' || typeof row.tool_call_id !== 'string'
      || !row.tool_call_id || row.tool_call_id.length > 512 || typeof row.tool_name !== 'string'
      || row.tool_name.length > 240 || typeof row.outcome !== 'string') return;
  const at = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
  if (!Number.isFinite(at) || at <= 0 || at > Date.now() + 5_000) return;
  const previous = calls.get(row.tool_call_id);
  if (previous && previous.at > at) return;
  calls.delete(row.tool_call_id);
  calls.set(row.tool_call_id, { name: row.tool_name, outcome: row.outcome, at });
  while (calls.size > maximumCalls) calls.delete(calls.keys().next().value!);
}
