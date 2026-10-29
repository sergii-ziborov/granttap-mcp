import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify } from 'smol-toml';
import { TaskSchedulePatch } from '../../../../packages/protocol/task-schedules';
import type { ScheduleRepositoryOptions, StoredSchedule } from '.';
import { changeNativeSchedule } from './native-change';
import { validateScheduleRule } from './cadence';

function privateCheckpoint(path: string, bytes: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, bytes); fsyncSync(descriptor);
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || readFileSync(path, 'utf8') !== bytes) throw error;
  }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function retainRecentCheckpoints(root: string, id: string, retained: string[]): void {
  try {
    const pattern = new RegExp('^' + id + '-[a-f0-9]{64}-(before|proposed-[a-f0-9]{64})\\.toml$');
    const paths = readdirSync(root).filter(name => pattern.test(name)).map(name => join(root, name))
      .filter(path => lstatSync(path).isFile()).sort((a, b) => lstatSync(b).mtimeMs - lstatSync(a).mtimeMs);
    for (const path of paths.slice(20)) if (!retained.includes(path)) rmSync(path);
  } catch { /* Retention cannot turn a successful native save into a failed edit. */ }
}

/** Both the old and proposed configuration survive a failed or concurrent write. */
export function changeStoredSchedule(stored: StoredSchedule, revision: string, input: TaskSchedulePatch,
  options: ScheduleRepositoryOptions): void {
  if (stored.schedule.revision !== revision) throw Error('This automation changed. Refresh before editing it.');
  if (!stored.schedule.editable) throw Error(stored.schedule.reason ?? 'This automation is read-only.');
  const patch = TaskSchedulePatch.parse(input);
  const needsRule = patch.rrule != null || patch.status === 'ACTIVE' && stored.schedule.status !== 'ACTIVE';
  if (needsRule && !validateScheduleRule(patch.rrule ?? stored.schedule.rrule)) throw Error('Choose a supported schedule.');
  const now = options.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw Error('The computer clock is unavailable.');
  const record = { ...stored.record, ...patch, updated_at: Math.max(now, Number(stored.record.updated_at ?? 0) + 1) };
  const proposed = stringify(record);
  if (Buffer.byteLength(proposed) > 65_536) throw Error('The automation exceeds its native file size limit.');
  mkdirSync(options.backupRoot, { recursive: true, mode: 0o700 });
  const base = stored.schedule.id + '-' + revision;
  const before = join(options.backupRoot, base + '-before.toml');
  const after = join(options.backupRoot, base + '-proposed-' + createHash('sha256').update(proposed).digest('hex') + '.toml');
  privateCheckpoint(before, stored.text);
  privateCheckpoint(after, proposed);
  options.beforeCommit?.();
  changeNativeSchedule(stored, record, { root: options.root, now, writeMirror: () => {
    const latest = lstatSync(stored.path);
    if (latest.isSymbolicLink() || !latest.isFile() || latest.size > 65_536
      || createHash('sha256').update(readFileSync(stored.path)).digest('hex') !== revision) {
      throw Error('This automation changed. Refresh before editing it.');
    }
    replaceFile(stored.path, proposed);
  }, restoreMirror: () => {
    if (readFileSync(stored.path, 'utf8') === proposed) replaceFile(stored.path, stored.text);
  } });
  retainRecentCheckpoints(options.backupRoot, stored.schedule.id, [before, after]);
}

function replaceFile(path: string, text: string): void {
  const temporary = join(dirname(path), '.granttap-schedule-' + randomUUID());
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, text); fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}
