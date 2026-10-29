import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInvocationIngestor } from '../../../apps/bridge/src/engine/invocation/ingest';
import { EngineRemoteError, type EngineOperation, type EngineResult } from '../../../apps/bridge/src/engine/protocol/engine-protocol';
import type { SessionInfo } from '../../../packages/protocol/schema';

type Event = Extract<EngineOperation, { operation: 'invocation.observe' }>['input'];

function source(calls: string[]) {
  const path = join(mkdtempSync(join(tmpdir(), 'granttap-ingest-recovery-')), 'session.jsonl');
  writeFileSync(path, calls.map(id => JSON.stringify({ message: { content: [
    { type: 'tool_use', id, name: 'Read', input: {} },
  ] } })).join('\n') + '\n');
  return { path, session: { sessionId: 'session', agent: 'claude', projectId: 'project', taskId: 'task', cwd: '/repo' } as SessionInfo };
}

test('journal capacity failures back off without dropping the original evidence or advancing its source', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const { path, session } = source(['retained-call']);
  for (const failure of [
    new EngineRemoteError('INVOCATION_CAPACITY', 'invocation history is full; no event was discarded'),
    new EngineRemoteError('INVOCATION_STATE_WRITE_FAILED', 'engine Invocation history exceeds its size limit'),
  ]) {
    const events: Event[] = [];
    let full = true;
    const client = { request: async (op: EngineOperation): Promise<EngineResult> => {
      if (op.operation === 'engine.ping') return { operation: 'engine.pong', engine_version: 'test' };
      if (op.operation !== 'invocation.observe') throw Error('Unexpected operation');
      events.push(op.input);
      if (full) throw failure;
      return { operation: 'invocation.observed', sequence: 1 };
    } };
    const ingest = createInvocationIngestor({ client, enabled: () => true, computer: () => 'mac',
      paths: () => [path], inspect: () => ({ root: '/repo', canonicalRepositoryId: 'repo' }), now: () => Date.now() });
    assert.equal(await ingest.ingest([session]), 0);
    for (let n = 0; n < 20; n++) assert.equal(await ingest.ingest([session]), 0);
    assert.equal(events.length, 1, 'A full journal must not repeatedly clone and serialize its entire history');
    full = false;
    t.mock.timers.setTime(Date.now() + 5 * 60_000 + 1);
    assert.equal(await ingest.ingest([session]), 1);
    assert.deepEqual(events[1], events[0], 'The same evidence survives a delayed retry, even without a native timestamp');
    assert.equal(await ingest.ingest([session]), 0);
    assert.equal(events.length, 2, 'Only confirmed completion advances the source cursor');
  }
});

test('a retry retains the failed event and does not resubmit the confirmed prefix of its batch', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const { path, session } = source(['confirmed-call', 'uncertain-call']);
  const events: Event[] = [];
  let failOnce = true;
  const client = { request: async (op: EngineOperation): Promise<EngineResult> => {
    if (op.operation === 'engine.ping') return { operation: 'engine.pong', engine_version: 'test' };
    if (op.operation !== 'invocation.observe') throw Error('Unexpected operation');
    events.push(op.input);
    if (events.length === 2 && failOnce) { failOnce = false; throw Error('engine request deadline exceeded'); }
    return { operation: 'invocation.observed', sequence: events.length };
  } };
  const ingest = createInvocationIngestor({ client, enabled: () => true, computer: () => 'mac',
    paths: () => [path], inspect: () => ({ root: '/repo', canonicalRepositoryId: 'repo' }), now: () => Date.now() });
  assert.equal(await ingest.ingest([session]), 1);
  t.mock.timers.setTime(61_001);
  assert.equal(await ingest.ingest([session]), 1);
  assert.deepEqual(events.map(e => e.native_call_id), ['confirmed-call', 'uncertain-call', 'uncertain-call']);
  assert.deepEqual(events[1], events[2], 'Uncertain delivery retries the exact original event');
  assert.equal(await ingest.ingest([session]), 0);
  assert.equal(events.length, 3);
});

test('evidence appended during a failed delivery follows the retained batch', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const { path, session } = source(['earlier']);
  const events: Event[] = [];
  let fail = true;
  const client = { request: async (op: EngineOperation): Promise<EngineResult> => {
    if (op.operation === 'engine.ping') return { operation: 'engine.pong', engine_version: 'test' };
    if (op.operation !== 'invocation.observe') throw Error('Unexpected operation');
    events.push(op.input);
    if (fail) { fail = false; throw Error('temporary IPC failure'); }
    return { operation: 'invocation.observed', sequence: events.length };
  } };
  const ingest = createInvocationIngestor({ client, enabled: () => true, computer: () => 'mac',
    paths: () => [path], inspect: () => ({ root: '/repo', canonicalRepositoryId: 'repo' }) });
  assert.equal(await ingest.ingest([session]), 0);
  appendFileSync(path, JSON.stringify({ message: { content: [{ type: 'tool_use', id: 'later', name: 'Read', input: {} }] } }) + '\n');
  t.mock.timers.setTime(2_001);
  assert.equal(await ingest.ingest([session]), 1);
  assert.deepEqual(events[0], events[1]);
  assert.equal(await ingest.ingest([session]), 1);
  assert.deepEqual(events.map(e => e.native_call_id), ['earlier', 'earlier', 'later']);
});

test('pending source memory is bounded and deferred source data stays available', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const sources = Array.from({ length: 33 }, (_, n) => source(['call-' + n]));
  let current = sources[0]!;
  let full = true;
  const events: Event[] = [];
  const client = { request: async (op: EngineOperation): Promise<EngineResult> => {
    if (op.operation === 'engine.ping') return { operation: 'engine.pong', engine_version: 'test' };
    if (op.operation !== 'invocation.observe') throw Error('Unexpected operation');
    events.push(op.input);
    if (full) throw new EngineRemoteError('INVOCATION_CAPACITY', 'full');
    return { operation: 'invocation.observed', sequence: events.length };
  } };
  const ingest = createInvocationIngestor({ client, enabled: () => true, computer: () => 'mac',
    paths: () => [current.path], inspect: () => ({ root: '/repo', canonicalRepositoryId: 'repo' }) });
  for (const item of sources) {
    current = item;
    t.mock.timers.setTime(Date.now() + 5 * 60_000 + 1);
    assert.equal(await ingest.ingest([current.session]), 0);
  }
  assert.equal(events.length, 32);
  full = false; current = sources[0]!;
  assert.equal(await ingest.ingest([current.session]), 1);
  assert.deepEqual(events[0], events[32]);
  current = sources[32]!;
  assert.equal(await ingest.ingest([current.session]), 1);
  assert.equal(events.at(-1)?.native_call_id, 'call-32');
});
