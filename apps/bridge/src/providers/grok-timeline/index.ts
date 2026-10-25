import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

type ClockCache = { size: number; modified: number; inode: number; clocks: Map<number, number> };
const cached = new Map<string, ClockCache>();

/** Native rewind records put the prompt identity and clock before potentially huge file snapshots. */
function recordHeaders(path: string, visit: (header: string) => void): void {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0, header = '';
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, offset);
      if (!count) break;
      offset += count;
      let from = 0;
      while (from < count) {
        const newline = buffer.indexOf(10, from);
        const end = newline < 0 || newline >= count ? count : newline;
        if (header.length < 1024) header += buffer.subarray(from, Math.min(end, from + 1024 - header.length)).toString('utf8');
        if (end === count) break;
        visit(header); header = ''; from = end + 1;
      }
    }
    if (header) visit(header);
  } finally { closeSync(fd); }
}

function promptTimes(directory: string): Map<number, number> {
  const path = join(directory, 'rewind_points.jsonl');
  try {
    const stat = statSync(path), prior = cached.get(path);
    if (prior?.size === stat.size && prior.modified === stat.mtimeMs && prior.inode === stat.ino) return prior.clocks;
    const clocks = new Map<number, number>();
    recordHeaders(path, header => {
      const match = /^\s*\{\s*"prompt_index"\s*:\s*(\d+)\s*,\s*"created_at"\s*:\s*"([^"]+)"\s*[,}]/.exec(header);
      if (!match) return;
      const index = Number(match[1]), at = Date.parse(match[2]!);
      if (Number.isSafeInteger(index) && Number.isFinite(at) && at > 0) clocks.set(index, at);
    });
    cached.delete(path);
    cached.set(path, { size: stat.size, modified: stat.mtimeMs, inode: stat.ino, clocks });
    while (cached.size > 128) cached.delete(cached.keys().next().value!);
    return clocks;
  } catch { return new Map(); }
}

function completedTurn(directory: string): number | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(join(directory, 'events.jsonl'), 'r');
    const size = fstatSync(fd).size, length = Math.min(size, 64 * 1024);
    const bytes = Buffer.alloc(length);
    const count = readSync(fd, bytes, 0, length, size - length);
    const lines = bytes.subarray(0, count).toString('utf8').split('\n');
    if (size > length) lines.shift();
    for (const line of lines.reverse()) {
      let row: Record<string, unknown>;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.type === 'turn_started') return undefined;
      if (row.type !== 'turn_ended') continue;
      const at = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
      return ['completed', 'success'].includes(String(row.outcome)) && Number.isFinite(at) && at > 0 ? at : undefined;
    }
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
  return undefined;
}

/** Read only native turn clocks and completion, never prompts, snapshots or reasoning. */
export function grokTimeline(directory: string): { prompts: Map<number, number>; completedAt?: number } {
  return { prompts: promptTimes(directory), completedAt: completedTurn(directory) };
}
