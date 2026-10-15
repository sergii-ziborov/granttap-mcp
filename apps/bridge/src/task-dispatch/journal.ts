import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, ftruncateSync, openSync, readFileSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { InboxState, type InboxState as State } from './records';

export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function writeRequest(path: string, value: unknown): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify({ value, digest: digest(value) })); fsyncSync(fd); }
    finally { closeSync(fd); }
    // Publish only a complete, flushed inode. link preserves the no-overwrite contract.
    linkSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    try { unlinkSync(temporary); } catch { /* A later private-store cleanup can remove an orphan temp file. */ }
  }
}

export function readRequest(path: string): unknown {
  const stored = JSON.parse(readFileSync(path, 'utf8')) as { value: unknown; digest: string };
  if (stored.digest !== digest(stored.value)) throw new Error('Unreadable local task queue record');
  return stored.value;
}

export function readJournal(path: string, initial: State) {
  let data: Buffer;
  try { data = readFileSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: initial, sequence: 0, previous: '', bytes: 0 }; throw error; }
  const bytes = data.lastIndexOf(10) + 1;
  const lines = data.subarray(0, bytes).toString('utf8').split('\n').slice(0, -1);
  let state = initial, sequence = 0, previous = '';
  for (const line of lines) {
    const record = JSON.parse(line) as { sequence: number; previous: string; event: unknown; digest: string };
    const content = { sequence: record.sequence, previous: record.previous, event: record.event };
    if (record.sequence !== sequence + 1 || record.previous !== previous || record.digest !== digest(content)) {
      throw new Error('Unreadable local task queue journal');
    }
    state = InboxState.parse(record.event);
    sequence = record.sequence; previous = record.digest;
  }
  return { state, sequence, previous, bytes };
}

export function appendState(path: string, initial: State, event: State): void {
  const current = readJournal(path, initial);
  const value = { sequence: current.sequence + 1, previous: current.previous, event };
  const fd = openSync(path, 'a', 0o600);
  try {
    ftruncateSync(fd, current.bytes);
    writeFileSync(fd, JSON.stringify({ ...value, digest: digest(value) }) + '\n');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}

export function syncDirectory(path: string): void {
  let fd: number | undefined;
  try { fd = openSync(path, 'r'); fsyncSync(fd); }
  catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
