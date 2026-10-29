import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { stringify } from 'smol-toml';
import { createTaskScheduleRepository } from '..';
import { validateScheduleRule } from '../cadence';
import { nativeFixture } from './native-fixture';

function fixture(t: test.TestContext, beforeCommit?: () => void) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-native-schedule-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, 'automations', 'qa'); mkdirSync(folder, { recursive: true });
  const path = join(folder, 'automation.toml');
  const record = { version: 1, id: 'qa', kind: 'heartbeat', name: 'Fixture', prompt: 'Fixture only.',
    status: 'ACTIVE', rrule: 'FREQ=HOURLY;INTERVAL=1', target_thread_id: 'chat', created_at: 1000, updated_at: 1000 };
  writeFileSync(path, stringify(record));
  const native = nativeFixture(root, record);
  const repository = createTaskScheduleRepository({ root, backupRoot: join(root, 'backups'), now: () => 2000, beforeCommit });
  function sql(command: string) { const db = new DatabaseSync(native); try { db.exec(command); } finally { db.close(); } }
  function row() {
    const db = new DatabaseSync(native, { readOnly: true });
    try { return db.prepare('SELECT * FROM automations WHERE id=?').get('qa')!; } finally { db.close(); }
  }
  return { root, path, native, repository, sql, row, current: () => repository.list(['chat']).schedules[0]! };
}

test('renaming an active schedule preserves its next occurrence and unrelated execution state', t => {
  const f = fixture(t); f.sql('UPDATE automations SET last_run_at=900');
  const before = f.row(); const current = f.current();
  const changed = f.repository.change('qa', current.revision, { name: 'Renamed', prompt: 'Updated fixture.' }, ['chat']);
  assert.equal(changed.confirmation, 'confirmed');
  assert.equal(f.row().next_run_at, before.next_run_at);
  assert.equal(f.row().next_run_nominal_at, before.next_run_nominal_at);
  assert.equal(f.row().last_run_at, 900);
  assert.equal(f.row().model, before.model);
  assert.equal(f.row().prompt, 'Updated fixture.');
});

test('resuming and changing cadence schedule only a future occurrence without creating another automation', t => {
  const f = fixture(t);
  f.repository.change('qa', f.current().revision, { status: 'PAUSED' }, ['chat']);
  const resumed = f.repository.change('qa', f.current().revision, { status: 'ACTIVE', rrule: 'FREQ=MINUTELY;INTERVAL=5' }, ['chat']);
  assert.equal(resumed.confirmation, 'confirmed'); assert.equal(resumed.status, 'ACTIVE');
  assert.equal(f.row().next_run_at, 302_000);
  assert.equal(f.row().next_run_at, f.row().next_run_nominal_at);
  assert.deepEqual(readdirSync(join(f.root, 'automations')), ['qa']);
});

test('native changes during the edit are preserved and cannot be reported as a successful pause', t => {
  let change: (() => void) | undefined;
  const f = fixture(t, () => change?.());
  const before = readFileSync(f.path, 'utf8'); const current = f.current();
  change = () => f.sql("UPDATE automations SET name='Changed in native app',updated_at=1500");
  assert.throws(() => f.repository.change('qa', current.revision, { status: 'PAUSED' }, ['chat']), /changed/i);
  assert.equal(readFileSync(f.path, 'utf8'), before);
  assert.equal(f.row().name, 'Changed in native app'); assert.equal(f.row().status, 'ACTIVE');
  assert.equal(f.current().editable, false); assert.equal(f.current().confirmation, 'waiting');
});

test('external mirror edits survive and the native transaction rolls back', t => {
  let change: (() => void) | undefined;
  const f = fixture(t, () => change?.()); const current = f.current();
  const external = readFileSync(f.path, 'utf8').replace('Fixture only.', 'External edit.');
  change = () => writeFileSync(f.path, external);
  assert.throws(() => f.repository.change('qa', current.revision, { status: 'PAUSED' }, ['chat']), /changed/i);
  assert.equal(readFileSync(f.path, 'utf8'), external); assert.equal(f.row().status, 'ACTIVE');
  assert.equal(readdirSync(join(f.root, 'backups')).length, 2);
});

test('a native COMMIT failure restores the original mirror and preserves both checkpoints', t => {
  const f = fixture(t); const before = readFileSync(f.path, 'utf8');
  f.sql(`CREATE TABLE valid_names (id TEXT PRIMARY KEY);
    CREATE TABLE pending_names (id TEXT REFERENCES valid_names(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER reject_edit AFTER UPDATE ON automations BEGIN INSERT INTO pending_names VALUES('missing'); END;`);
  assert.throws(() => f.repository.change('qa', f.current().revision, { status: 'PAUSED' }, ['chat']), /constraint/i);
  assert.equal(readFileSync(f.path, 'utf8'), before); assert.equal(f.row().status, 'ACTIVE');
  assert.equal(readdirSync(join(f.root, 'backups')).length, 2);
});

test('cloud ownership, deletion and a missing native store are read-only', async t => {
  for (const condition of ['account_id', 'user_id', 'installation_id', 'deleted', 'missing']) {
    await t.test(condition, sub => {
      const f = fixture(sub);
      if (condition === 'missing') rmSync(f.native);
      else if (condition === 'deleted') f.sql("UPDATE automations SET status='DELETED'");
      else f.sql(`UPDATE automations SET ${condition}='foreign-owner'`);
      const current = f.current(); assert.equal(current.editable, false);
      const before = readFileSync(f.path, 'utf8');
      assert.throws(() => f.repository.change('qa', current.revision, { status: 'PAUSED' }, ['chat']), /native|read-only|account|changed/i);
      assert.equal(readFileSync(f.path, 'utf8'), before);
    });
  }
});

test('an unavailable checkpoint aborts before either native representation changes', t => {
  const f = fixture(t); const current = f.current(); const before = readFileSync(f.path, 'utf8');
  writeFileSync(join(f.root, 'backups'), 'blocked');
  assert.throws(() => f.repository.change('qa', current.revision, { status: 'PAUSED' }, ['chat']));
  assert.equal(readFileSync(f.path, 'utf8'), before); assert.equal(f.row().status, 'ACTIVE');
});

test('ambiguous native databases do not grant control over either scheduler', t => {
  const f = fixture(t);
  const first = new DatabaseSync(f.native);
  first.prepare('VACUUM INTO ?').run(join(f.root, 'sqlite', 'codex.db')); first.close();
  assert.equal(f.current().editable, false);
});

test('a migrated native scheduler stays read-only even if an old local mirror still exists', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, '.codex-global-state.json'), JSON.stringify({
    'electron-persisted-atom-state': { 'electron-automations-habitat-migration-state': { fixture: 'complete' } },
  }));
  assert.equal(f.current().editable, false);
});

test('unsupported schedules are rejected before changing any saved state', t => {
  const f = fixture(t); const before = readFileSync(f.path, 'utf8');
  for (const rule of ['FREQ=YEARLY', 'FREQ=HOURLY;COUNT=1', 'FREQ=DAILY;BYHOUR=24', 'FREQ=DAILY;BYMINUTE=60',
    'FREQ=HOURLY;INTERVAL=0', 'FREQ=HOURLY;INTERVAL=1;INTERVAL=2', 'FREQ=DAILY;BYDAY=XX', 'FREQ=HOURLY;BROKEN',
    'FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0;BYDAY=MO,', 'FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0;BYDAY=MO,MO']) {
    assert.equal(validateScheduleRule(rule), false);
    assert.throws(() => f.repository.change('qa', f.current().revision, { rrule: rule }, ['chat']), /supported/i);
  }
  assert.equal(validateScheduleRule('FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=9;BYMINUTE=30'), true);
  assert.equal(readFileSync(f.path, 'utf8'), before); assert.equal(f.row().status, 'ACTIVE');
});

test('wall-clock schedules retain the chosen local hour across a daylight-saving change', t => {
  const previous = process.env.TZ;
  process.env.TZ = 'Europe/Berlin';
  t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
  const f = fixture(t), now = Date.parse('2026-10-24T12:00:00Z');
  const repository = createTaskScheduleRepository({ root: f.root, backupRoot: join(f.root, 'backups'), now: () => now });
  repository.change('qa', f.current().revision, { rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=30' }, ['chat']);
  assert.equal(f.row().next_run_at, Date.parse('2026-10-25T08:30:00Z'));
});
