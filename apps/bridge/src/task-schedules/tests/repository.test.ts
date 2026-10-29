import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse, stringify } from 'smol-toml';
import { createTaskScheduleRepository } from '..';
import { DatabaseSync } from 'node:sqlite';
import { nativeFixture } from './native-fixture';

test('a chat edits and pauses its existing native heartbeat without replacing other settings', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-schedules-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, 'automations', 'qa'); mkdirSync(folder, { recursive: true });
  const path = join(folder, 'automation.toml');
  const original = { version: 1, id: 'qa', kind: 'heartbeat', name: 'Example', prompt: 'Read the fixture.',
    status: 'ACTIVE', rrule: 'FREQ=HOURLY;INTERVAL=1', target_thread_id: 'chat',
    created_at: 1000, updated_at: 1000, model: 'unchanged', extra: { custom: ['retain', 'these'] } };
  writeFileSync(path, stringify(original));
  const nativePath = nativeFixture(root, original);
  const repository = createTaskScheduleRepository({ root, backupRoot: join(root, 'backups'), now: () => 2000 });
  assert.deepEqual(repository.list(['other']).schedules, [], 'Another chat cannot read this prompt');
  const before = repository.list(['chat']).schedules[0]!;
  const changed = repository.change('qa', before.revision, { status: 'PAUSED', name: 'Edited' }, ['chat']);
  assert.equal(changed.id, before.id);
  assert.equal(changed.status, 'PAUSED');
  const database = new DatabaseSync(nativePath, { readOnly: true });
  const native = database.prepare('SELECT * FROM automations WHERE id=?').get('qa')!;
  database.close();
  assert.equal(native.status, 'PAUSED', 'Pause must reach the native scheduler, not just its TOML mirror');
  assert.equal(native.next_run_at, null);
  assert.equal(native.next_run_nominal_at, null);
  assert.equal(native.model, 'retain-model');
  assert.equal(native.name, 'Edited');
  assert.equal(changed.confirmation, 'confirmed');
  const saved = parse(readFileSync(path, 'utf8'));
  assert.deepEqual(saved, parse(stringify({ ...original, status: 'PAUSED', name: 'Edited', updated_at: 2000 })));
  assert.throws(() => repository.change('qa', before.revision, { status: 'ACTIVE' }, ['chat']), /changed|refresh/i);
  assert.throws(() => repository.change('qa', changed.revision, { status: 'ACTIVE' }, ['other']), /unavailable|scope/i);
});
