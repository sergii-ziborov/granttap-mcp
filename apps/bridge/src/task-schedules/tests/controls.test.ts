import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stringify } from 'smol-toml';
import { createTaskScheduleRepository } from '..';
import { TaskScheduleControls } from '../controls';
import type { TaskSchedulesRequest, TaskSchedulesResult } from '../../../../../packages/protocol/task-schedules';
import { nativeFixture } from './native-fixture';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-schedule-controller-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const record = { version: 1, id: 'qa', kind: 'heartbeat', name: 'Fixture', prompt: 'Fixture only.',
    status: 'ACTIVE', rrule: 'FREQ=HOURLY;INTERVAL=1', target_thread_id: 'chat', created_at: 1000, updated_at: 1000 };
  const folder = join(root, 'automations', 'qa'); mkdirSync(folder, { recursive: true });
  const path = join(folder, 'automation.toml'); writeFileSync(path, stringify(record)); nativeFixture(root, record);
  const repository = createTaskScheduleRepository({ root, backupRoot: join(root, 'backups'), now: () => 2000 });
  let now = 2000;
  const controls = new TaskScheduleControls(repository, () => now);
  const sent: TaskSchedulesResult[] = [];
  const context = { controller: 'paired-controller', sessions: ['chat'], send: async (r: TaskSchedulesResult) => { sent.push(r); } };
  const query: TaskSchedulesRequest = { type: 'task.schedules', requestId: 'list', sessionId: 'chat', createdAt: 2000 };
  return { root, path, repository, controls, sent, context, query, clock: (value: number) => { now = value; } };
}

test('five repeated taps and a lost receipt apply the existing native change only once', async t => {
  const f = fixture(t); const row = f.repository.list(['chat']).schedules[0]!;
  const request = { ...f.query, requestId: 'pause', change: { id: 'qa', revision: row.revision, patch: { status: 'PAUSED' as const } } };
  let failed = false;
  const lost = { ...f.context, send: async () => { failed = true; throw Error('Lost receipt'); } };
  await assert.rejects(f.controls.handle(request, lost), /Lost receipt/); assert.equal(failed, true);
  const after = readFileSync(f.path, 'utf8');
  for (let index = 0; index < 5; index++) assert.equal(await f.controls.handle(request, f.context), true);
  assert.equal(readFileSync(f.path, 'utf8'), after);
  assert.equal(readdirSync(join(f.root, 'backups')).length, 2);
  assert.equal(f.sent.length, 5);
  assert.ok(f.sent.every(result => result.phase === 'completed' && result.schedules[0]?.status === 'PAUSED'));
  assert.equal(await f.controls.handle({ ...request, change: { ...request.change, patch: { status: 'ACTIVE' } } }, f.context), false);
});

test('a query and a controller without a native chat cannot mutate or read another chat', async t => {
  const f = fixture(t), before = readFileSync(f.path);
  assert.equal(await f.controls.handle(f.query, f.context), true);
  assert.equal(f.sent[0]?.schedules[0]?.name, 'Fixture');
  assert.equal(await f.controls.handle({ ...f.query, requestId: 'foreign' }, { ...f.context, sessions: [] }), true);
  assert.equal(f.sent.at(-1)?.phase, 'unavailable'); assert.deepEqual(f.sent.at(-1)?.schedules, []);
  await f.controls.handle({ ...f.query, requestId: 'other' }, { ...f.context, sessions: ['other-chat'] });
  assert.deepEqual(f.sent.at(-1)?.schedules, []); assert.deepEqual(readFileSync(f.path), before);
});

test('stale and malformed controller input is refused without creating an operation', async t => {
  const f = fixture(t);
  assert.equal(await f.controls.handle({ ...f.query, createdAt: -200_000 }, f.context), false);
  assert.equal(await f.controls.handle({ ...f.query, change: { id: 'qa', revision: 'bad', patch: {} } }, f.context), false);
  assert.deepEqual(f.sent, []);
});

test('a failed native edit returns a safe message and retains the current automation', async t => {
  const f = fixture(t), before = readFileSync(f.path);
  const row = f.repository.list(['chat']).schedules[0]!;
  await f.controls.handle({ ...f.query, change: { id: 'qa', revision: row.revision, patch: { rrule: 'FREQ=YEARLY' } } }, f.context);
  assert.equal(f.sent[0]?.phase, 'failed'); assert.match(f.sent[0]?.message ?? '', /supported/);
  assert.deepEqual(readFileSync(f.path), before);
  rmSync(join(f.root, 'automations'), { recursive: true }); writeFileSync(join(f.root, 'automations'), 'Private fixture text');
  await f.controls.handle({ ...f.query, requestId: 'storage-error' }, f.context);
  assert.equal(f.sent.at(-1)?.phase, 'failed'); assert.doesNotMatch(f.sent.at(-1)?.message ?? '', /Private fixture text|granttap-schedule-controller/);
});

test('bounded request identities expire and cannot be reused to apply another edit', async t => {
  const f = fixture(t);
  for (let index = 0; index < 128; index++) await f.controls.handle({ ...f.query, requestId: String(index) }, f.context);
  assert.equal(await f.controls.handle({ ...f.query, requestId: 'overflow' }, f.context), true);
  assert.equal(f.sent.at(-1)?.phase, 'unavailable');
  f.clock(200_001);
  assert.equal(await f.controls.handle({ ...f.query, requestId: 'new', createdAt: 200_001 }, f.context), true);
});

test('a changed automation remains in the bounded reply even when its instructions grow', async t => {
  const f = fixture(t), current = f.repository.list(['chat']).schedules[0]!;
  for (let index = 0; index < 30; index++) {
    const id = 'other-' + index, folder = join(f.root, 'automations', id); mkdirSync(folder);
    writeFileSync(join(folder, 'automation.toml'), stringify({ version: 1, id, kind: 'heartbeat', name: id,
      prompt: 'x'.repeat(2000), rrule: 'FREQ=HOURLY', status: 'PAUSED', target_thread_id: 'chat', created_at: 1, updated_at: 1 }));
  }
  const prompt = '字'.repeat(8192);
  await f.controls.handle({ ...f.query, change: { id: 'qa', revision: current.revision, patch: { prompt } } }, f.context);
  assert.equal(f.sent[0]?.phase, 'completed'); assert.equal(f.sent[0]?.schedules[0]?.id, 'qa');
  assert.equal(f.sent[0]?.schedules[0]?.prompt, prompt);
  assert.equal(f.sent[0]?.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(f.sent[0])) <= 65_536);
});
