import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stringify } from 'smol-toml';
import { createTaskScheduleRepository } from '..';
import { nativeFixture } from './native-fixture';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-schedule-input-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const record = { version: 1, id: 'qa', kind: 'heartbeat', name: 'Fixture', prompt: 'Fixture only.',
    status: 'ACTIVE', rrule: 'FREQ=HOURLY;INTERVAL=1', target_thread_id: 'chat', created_at: 1000, updated_at: 1000 };
  const folder = join(root, 'automations', 'qa'); mkdirSync(folder, { recursive: true });
  const path = join(folder, 'automation.toml'); writeFileSync(path, stringify(record));
  const native = nativeFixture(root, record);
  const options = { root, backupRoot: join(root, 'backups'), now: () => 2000 };
  const repository = createTaskScheduleRepository(options);
  return { root, folder, path, record, native, options, repository };
}

test('malformed, future and unrelated native files never enter this chat', async t => {
  const changes = [{ version: 2 }, { kind: 'cron' }, { id: 'another' }, { target_thread_id: 'other' },
    { created_at: -1 }, { updated_at: -1 }, { updated_at: NaN }, { created_at: NaN }, { name: '' }, { prompt: 'x'.repeat(8193) }];
  for (const [index, change] of changes.entries()) await t.test(String(index), sub => {
    const f = fixture(sub); writeFileSync(f.path, stringify({ ...f.record, ...change }));
    assert.deepEqual(f.repository.list(['chat']).schedules, []);
  });
  for (const [index, bytes] of [Buffer.from([255]), Buffer.from('broken = [ ] ='), Buffer.alloc(65_537)].entries()) {
    await t.test('bytes-' + index, sub => {
      const f = fixture(sub); writeFileSync(f.path, bytes);
      assert.deepEqual(f.repository.list(['chat']).schedules, []);
    });
  }
});

test('native paths cannot follow a file or folder symlink outside their root', async t => {
  for (const kind of ['file', 'folder', 'database']) await t.test(kind, sub => {
    const f = fixture(sub); const target = kind === 'file' ? f.path : kind === 'folder' ? f.folder : f.native;
    const copy = join(f.root, 'outside');
    if (kind === 'folder') { mkdirSync(copy); writeFileSync(join(copy, 'automation.toml'), stringify(f.record)); }
    else writeFileSync(copy, readFileSync(target));
    rmSync(target, { recursive: true }); symlinkSync(copy, target);
    const rows = f.repository.list(['chat']).schedules;
    assert.ok(kind === 'database' ? rows.length === 1 && !rows[0]!.editable : rows.length === 0);
  });
});

test('large collections report their limit and never exceed the encrypted response budget', t => {
  const f = fixture(t);
  for (let index = 0; index < 40; index++) {
    const id = 'item-' + index, folder = join(f.root, 'automations', id); mkdirSync(folder);
    writeFileSync(join(folder, 'automation.toml'), stringify({ ...f.record, id }));
  }
  let result = f.repository.list(['chat']);
  assert.equal(result.schedules.length, 32); assert.equal(result.truncated, true);
  for (let index = 0; index < 40; index++) {
    const id = 'item-' + index;
    writeFileSync(join(f.root, 'automations', id, 'automation.toml'), stringify({ ...f.record, id, prompt: 'x'.repeat(8192) }));
  }
  result = f.repository.list(['chat']);
  assert.ok(Buffer.byteLength(JSON.stringify(result.schedules)) < 65_536); assert.equal(result.truncated, true);
});

test('invalid clocks and foreign identifiers cannot alter saved native state', t => {
  const f = fixture(t), current = f.repository.list(['chat']).schedules[0]!, before = readFileSync(f.path);
  for (const now of [-1, NaN, Infinity]) {
    const repository = createTaskScheduleRepository({ ...f.options, now: () => now });
    assert.throws(() => repository.change('qa', current.revision, { status: 'PAUSED' }, ['chat']), /clock/i);
  }
  assert.throws(() => f.repository.change('../qa', current.revision, { status: 'PAUSED' }, ['chat']), /unavailable/i);
  assert.deepEqual(readFileSync(f.path), before);
  rmSync(join(f.root, 'automations'), { recursive: true });
  assert.deepEqual(f.repository.list(['chat']), { schedules: [], truncated: false });
});

test('daily and weekly schedules use a future time on the computer and keep the requested cadence', t => {
  const f = fixture(t);
  for (const rrule of ['FREQ=DAILY;BYHOUR=9;BYMINUTE=30', 'FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=10;BYMINUTE=0']) {
    const current = f.repository.list(['chat']).schedules[0]!;
    const changed = f.repository.change('qa', current.revision, { rrule }, ['chat']);
    assert.equal(changed.rrule, rrule); assert.equal(changed.confirmation, 'confirmed');
  }
});
