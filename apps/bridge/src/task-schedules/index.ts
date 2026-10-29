import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, type TomlTable } from 'smol-toml';
import { TaskSchedule, TaskSchedulePatch } from '../../../../packages/protocol/task-schedules';
import { changeStoredSchedule } from './changes';
import { nativeScheduleState } from './native-state';

export type ScheduleRepositoryOptions = { root: string; backupRoot: string; now?: () => number; beforeCommit?: () => void };
export type StoredSchedule = { path: string; text: string; record: TomlTable; schedule: TaskSchedule };
const validId = (id: string) => /^[a-zA-Z0-9_-]{1,160}$/.test(id);

/** Native Codex heartbeat records; no parallel scheduler or provider execution. */
export function createTaskScheduleRepository(options: ScheduleRepositoryOptions) {
  const directory = join(options.root, 'automations');
  function read(id: string, sessions: readonly string[]): StoredSchedule | undefined {
    if (!validId(id)) return undefined;
    const folder = join(directory, id), path = join(folder, 'automation.toml');
    try {
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()
        || !lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink()) return undefined;
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) return undefined;
      const bytes = readFileSync(path);
      if (!isUtf8(bytes)) return undefined;
      const text = bytes.toString('utf8'), record = parse(text);
      if (record.version !== 1 || record.id !== id || record.kind !== 'heartbeat'
        || typeof record.target_thread_id !== 'string' || !sessions.includes(record.target_thread_id)
        || !Number.isSafeInteger(record.created_at) || Number(record.created_at) < 0
        || !Number.isSafeInteger(record.updated_at) || Number(record.updated_at) < 0) return undefined;
      const parsed = TaskSchedule.safeParse({ id, sessionId: record.target_thread_id,
        name: record.name, prompt: record.prompt, rrule: record.rrule, status: record.status === 'DISABLED' ? 'PAUSED' : record.status,
        revision: createHash('sha256').update(text).digest('hex'), editable: true, confirmation: 'unavailable' });
      if (!parsed.success) return undefined;
      const schedule = { ...parsed.data, ...nativeScheduleState(options.root, parsed.data, record) };
      return { path, text, record, schedule };
    } catch { return undefined; }
  }
  return {
    list(sessions: readonly string[]) {
      if (!existsSync(directory)) return { schedules: [] as TaskSchedule[], truncated: false };
      const names = readdirSync(directory).slice(0, 512);
      const schedules: TaskSchedule[] = [];
      let bytes = 0, truncated = names.length === 512;
      for (const id of names) {
        const item = read(id, sessions)?.schedule;
        if (!item) continue;
        const size = Buffer.byteLength(JSON.stringify(item));
        if (schedules.length === 32 || bytes + size > 60_000) { truncated = true; break; }
        schedules.push(item); bytes += size;
      }
      return { schedules, truncated };
    },
    change(id: string, revision: string, patch: TaskSchedulePatch, sessions: readonly string[]): TaskSchedule {
      const stored = read(id, sessions);
      if (!stored) throw Error('This automation is unavailable in this chat.');
      changeStoredSchedule(stored, revision, patch, options);
      const saved = read(id, sessions);
      if (!saved) throw Error('The native automation changed after saving. Refresh its status.');
      return saved.schedule;
    },
  };
}
