import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { CapabilityUsageStatus, SessionInfo } from '../../../../../../packages/protocol/schema';
import { createSharedCapabilityReader } from '..';

const session = (projectId = 'project'): SessionInfo => ({ sessionId: 'source', agent: 'codex', projectId,
  state: 'idle', startedAt: 1, lastActivityAt: 2, tokensSession: 0, tokensLastTurn: 0 });
const report = (): CapabilityUsageStatus => ({ type: 'capability.usage.status', events: [], totals: [], generatedAt: 1 });

test('concurrent identical consumers share one expensive usage read and keep its original observation', async () => {
  let reads = 0, now = 0, release!: (value: CapabilityUsageStatus) => void;
  const held = new Promise<CapabilityUsageStatus>(resolve => { release = resolve; });
  const reader = createSharedCapabilityReader(async () => { reads++; return held; }, () => now);
  const pending = Array.from({ length: 6 }, () => reader([session()]));
  await setImmediate();
  assert.equal(reads, 1, 'Six connections must not parse the same history six times');
  now = 10_000;
  const seventh = reader([session()]);
  assert.equal(reads, 1, 'An unfinished read remains shared beyond the completed-cache lifetime');
  const value = report();
  release(value);
  const reports = await Promise.all([...pending, seventh]);
  assert.deepEqual(reports, Array.from({ length: 7 }, () => value));
  now += 999;
  assert.deepEqual(await reader([session()]), value);
  assert.equal(reads, 1);
  now += 2;
  await reader([session()]);
  assert.equal(reads, 2, 'New evidence is read after the short lifetime');
});

test('different scopes and changed session metadata cannot share usage, and input is frozen before awaits', async () => {
  const observed: SessionInfo[][] = [];
  const reader = createSharedCapabilityReader(async rows => { observed.push(rows); return report(); });
  const original = [session('first')];
  const first = reader(original);
  original[0]!.projectId = 'second';
  const second = reader(original);
  await Promise.all([first, second]);
  assert.equal(observed.length, 2);
  assert.equal(observed[0]![0]!.projectId, 'first');
  assert.equal(observed[1]![0]!.projectId, 'second');
  await reader([{ ...session('second'), lastActivityAt: 3 }]);
  assert.equal(observed.length, 3);
});

test('a failed read is retryable and a bounded cache does not retain every historical scope', async () => {
  let reads = 0;
  const reader = createSharedCapabilityReader(async () => {
    if (++reads === 1) throw Error('Synthetic read failure');
    return report();
  });
  await assert.rejects(reader([session()]), /Synthetic read failure/);
  await reader([session()]);
  assert.equal(reads, 2);
  for (let index = 0; index < 17; index++) await reader([session(`scope-${index}`)]);
  await reader([session()]);
  assert.equal(reads, 20, 'The oldest completed scope is evicted');
});
