import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stringify } from 'smol-toml';
import type { SessionInfo, TaskSchedulesResult } from '../../../../../packages/protocol/schema';
import { rememberPublishedCatalog } from '../../session-catalog';
import { handleTaskSchedules } from '../relay';
import { nativeFixture } from './native-fixture';

test('only a paired controller can edit automations of admitted native executions in this Task', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-schedule-route-'));
  const before = { ...process.env };
  Object.assign(process.env, { GRANTTAP_CONFIG_DIR: join(root, 'config'), GRANTTAP_CODEX_DIR: join(root, 'codex') });
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before); rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'config'));
  const machine = join(root, 'config', 'machine.json');
  writeFileSync(machine, JSON.stringify({ room: 'paired-room', role: 'machine', peerPublicKey: 'phone' }));
  const codex = join(root, 'codex'), folder = join(codex, 'automations', 'qa'); mkdirSync(folder, { recursive: true });
  const record = { version: 1, id: 'qa', kind: 'heartbeat', name: 'Owned automation', prompt: 'Fixture only.',
    status: 'ACTIVE', rrule: 'FREQ=HOURLY;INTERVAL=1', target_thread_id: 'codex-native', created_at: 1000, updated_at: 1000 };
  const path = join(folder, 'automation.toml'); writeFileSync(path, stringify(record)); nativeFixture(codex, record);
  const foreign = join(codex, 'automations', 'foreign'); mkdirSync(foreign);
  writeFileSync(join(foreign, 'automation.toml'), stringify({ ...record, id: 'foreign', target_thread_id: 'foreign-native', name: 'Private other Task' }));
  const results: { value: TaskSchedulesResult; session: string; to: string; options: any }[] = [];
  const grants: any[] = [];
  const client: any = { room: 'paired-room', setSessionKey() {}, send: async (value: any, _to: string, options: any) => { grants.push({ value, options }); },
    sendSession: async (value: TaskSchedulesResult, session: string, to: string, options: any) => { results.push({ value, session, to, options }); } };
  const session = (id: string, agent: SessionInfo['agent'], projectId = 'project', taskId = 'task'): SessionInfo => ({
    sessionId: id, agent, projectId, taskId, state: 'idle', startedAt: 1, lastActivityAt: 2, tokensSession: 0, tokensLastTurn: 0,
  });
  const sessions = [session('grok-root', 'grok'), session('codex-native', 'codex'), session('foreign-native', 'codex', 'other-project')];
  rememberPublishedCatalog(client, { type: 'sessions.status', machine: 'QA Mac', sessions, generatedAt: Date.now() });
  const query = { type: 'task.schedules' as const, requestId: 'list', sessionId: 'grok-root', createdAt: Date.now() };
  assert.equal(await handleTaskSchedules(client, query, undefined), false);
  assert.equal(await handleTaskSchedules(client, query, 'foreign-phone'), false);
  assert.equal(await handleTaskSchedules({ ...client, room: 'foreign-room' }, query, 'phone'), false);
  assert.equal(await handleTaskSchedules(client, { ...query, sessionId: 'unknown' }, 'phone'), false);
  assert.equal(await handleTaskSchedules(client, { ...query, createdAt: 0 }, 'phone'), false);
  assert.equal(results.length, 0);
  assert.equal(await handleTaskSchedules(client, query, 'phone'), true);
  assert.deepEqual(results[0]?.value.schedules.map(row => row.name), ['Owned automation']);
  assert.ok(results.every(row => row.session === 'grok-root' && row.to === 'phone' && row.options.peerPublicKey === 'phone'
    && row.options.reliable === false && row.options.urgent === true && row.options.ttlMs === 30_000));
  assert.equal(grants[0]?.value.type, 'session.key.grant');
  assert.ok(grants.every(grant => grant.options.urgent === true), 'The reply key must not wait behind transcript snapshots');
  const owned = results[0]!.value.schedules[0]!;
  const pause = { ...query, requestId: 'pause', change: { id: owned.id, revision: owned.revision, patch: { status: 'PAUSED' as const } } };
  assert.equal(await handleTaskSchedules(client, pause, 'phone'), true);
  const saved = readFileSync(path, 'utf8');
  for (let index = 0; index < 5; index++) await handleTaskSchedules(client, pause, 'phone');
  assert.equal(readFileSync(path, 'utf8'), saved);
  assert.equal(results.at(-1)?.value.schedules[0]?.status, 'PAUSED');
  await handleTaskSchedules(client, { ...pause, requestId: 'foreign-edit', change: { ...pause.change, id: 'foreign' } }, 'phone');
  assert.equal(results.at(-1)?.value.phase, 'failed');
  assert.doesNotMatch(JSON.stringify(results), /Private other Task/);
  rmSync(machine);
  assert.equal(await handleTaskSchedules(client, { ...query, requestId: 'revoked' }, 'phone'), false);
});
