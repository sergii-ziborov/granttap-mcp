import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import type { TomlTable } from 'smol-toml';
import type { StoredSchedule } from '.';
import { findNativeSchedule, sameNativeSchedule } from './native-state';
import { nextNativeOccurrence } from './cadence';

function nativeTimestamp(value: SQLOutputValue | undefined): number | null {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  throw Error('The native scheduler is unavailable.');
}

/** Commit the native scheduling state and its mirror together; never start a provider run. */
export function changeNativeSchedule(stored: StoredSchedule, record: TomlTable,
  commit: { root: string; now: number; writeMirror: () => void; restoreMirror: () => void }): void {
  const store = findNativeSchedule(commit.root, stored.schedule.id);
  if (!store) throw Error('The native scheduler is unavailable.');
  const database = new DatabaseSync(store.path);
  let fileChanged = false;
  try {
    database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=250; BEGIN IMMEDIATE;');
    const row = database.prepare('SELECT * FROM automations WHERE id=?').get(stored.schedule.id);
    if (!row || !sameNativeSchedule(row, stored.schedule, stored.record)) throw Error('This automation changed. Refresh before editing.');
    const reschedule = record.status === 'ACTIVE'
      && (row.status !== 'ACTIVE' || row.rrule !== record.rrule);
    const next = record.status === 'PAUSED' ? null : reschedule
      ? nextNativeOccurrence(String(record.rrule), commit.now) : nativeTimestamp(row.next_run_at);
    const nominal = record.status === 'PAUSED' ? null : reschedule ? next : nativeTimestamp(row.next_run_nominal_at);
    const result = database.prepare(`UPDATE automations SET name=?,prompt=?,status=?,rrule=?,updated_at=?,
      next_run_at=?,next_run_nominal_at=? WHERE id=? AND updated_at=? AND target_thread_id=?
      AND kind='heartbeat' AND account_id IS NULL AND user_id IS NULL AND installation_id IS NULL`)
      .run(String(record.name), String(record.prompt), String(record.status), String(record.rrule),
        Number(record.updated_at), next, nominal, stored.schedule.id,
        Number(stored.record.updated_at), stored.schedule.sessionId);
    if (result.changes !== 1) throw Error('This automation changed. Refresh before editing.');
    commit.writeMirror(); fileChanged = true;
    database.exec('COMMIT;');
  } catch (error) {
    try { database.exec('ROLLBACK;'); } catch { /* No open transaction after a failed BEGIN. */ }
    if (fileChanged) commit.restoreMirror();
    throw error;
  } finally { database.close(); }
}
