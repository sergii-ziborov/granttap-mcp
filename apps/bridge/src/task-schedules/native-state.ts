import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import type { TaskSchedule } from '../../../../packages/protocol/task-schedules';
import type { TomlTable } from 'smol-toml';

export type NativeScheduleRow = Record<string, SQLOutputValue>;
export type NativeScheduleStore = { path: string; row: NativeScheduleRow };
const columns = `id,name,prompt,status,rrule,updated_at,target_thread_id,kind,
  account_id,user_id,installation_id,next_run_at,next_run_nominal_at`;

function localScheduler(root: string): boolean {
  const path = join(root, '.codex-global-state.json');
  if (!existsSync(path)) return true;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) return false;
    const state = JSON.parse(readFileSync(path, 'utf8'));
    const migration = state?.['electron-persisted-atom-state']?.['electron-automations-habitat-migration-state'];
    return migration === undefined || migration != null && typeof migration === 'object'
      && !Array.isArray(migration) && Object.keys(migration).length === 0;
  } catch { return false; }
}

/** Only a single, local native record can be controlled. Cloud ownership is never inferred. */
export function findNativeSchedule(root: string, id: string): NativeScheduleStore | undefined {
  if (!localScheduler(root)) return undefined;
  const matches: NativeScheduleStore[] = [];
  for (const name of ['codex-dev.db', 'codex.db']) {
    const path = join(root, 'sqlite', name);
    let database: DatabaseSync | undefined;
    try {
      if (![root, join(root, 'sqlite')].every(item => lstatSync(item).isDirectory()
        && !lstatSync(item).isSymbolicLink())) continue;
      if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) continue;
      database = new DatabaseSync(path, { readOnly: true });
      database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=50;');
      const rows = database.prepare(`SELECT ${columns} FROM automations WHERE id=? OR legacy_automation_id=? LIMIT 2`).all(id, id);
      for (const row of rows) matches.push({ path, row });
    } catch { /* Locked, unsupported or incomplete stores remain read-only. */ }
    finally { database?.close(); }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export function sameNativeSchedule(row: NativeScheduleRow, schedule: TaskSchedule, record: TomlTable): boolean {
  return row.id === schedule.id && row.kind === 'heartbeat' && row.account_id == null
    && row.user_id == null && row.installation_id == null && row.name === schedule.name
    && row.prompt === schedule.prompt && row.status === schedule.status && row.rrule === schedule.rrule
    && row.target_thread_id === schedule.sessionId && row.updated_at === record.updated_at;
}

export function nativeScheduleState(root: string, schedule: TaskSchedule, record: TomlTable): Pick<TaskSchedule, 'editable' | 'confirmation' | 'reason'> {
  const store = findNativeSchedule(root, schedule.id);
  if (!store) return { editable: false, confirmation: 'unavailable', reason: 'The native scheduler is unavailable or has an unsupported storage version.' };
  if (store.row.account_id != null || store.row.user_id != null || store.row.installation_id != null) {
    return { editable: false, confirmation: 'unavailable', reason: 'This automation is managed by the Codex account.' };
  }
  if (!sameNativeSchedule(store.row, schedule, record)) {
    return { editable: false, confirmation: 'waiting', reason: 'The native automation changed. Refresh it in Codex before editing.' };
  }
  return { editable: true, confirmation: 'confirmed' };
}
