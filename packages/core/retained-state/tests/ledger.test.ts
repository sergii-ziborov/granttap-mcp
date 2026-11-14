import assert from 'node:assert/strict';
import test from 'node:test';
import type { Payload } from '../../../protocol/schema';
import { comparableMeshState, RETAINED_REFRESH_MS, RetainedStateLedger } from '../ledger';

const activity = (generatedAt: number, text = 'hello'): Payload => ({ type: 'session.activity', sessionId: 'chat-0001',
  agent: 'claude', state: 'idle', generatedAt, entries: [{ id: 'a', kind: 'final', text, createdAt: 1 }] });

test('a state already handed to the relay on this connection is not handed over again', () => {
  let now = 1_000;
  const ledger = new RetainedStateLedger(() => now);
  const first = activity(10);
  assert.equal(ledger.unchanged(first, 'phone'), false);
  ledger.remember(first, 'phone');
  assert.equal(ledger.unchanged(first, 'phone'), true);
  assert.equal(ledger.unchanged(activity(10), 'phone'), true, 'equal content counts, not the same object');
  assert.equal(ledger.unchanged(activity(11), 'phone'), false, 'a newer state goes');
  assert.equal(ledger.unchanged(activity(10, 'changed'), 'phone'), false, 'changed content goes');
  assert.equal(ledger.unchanged(first, 'all'), false, 'another audience has its own copy');
  now += RETAINED_REFRESH_MS;
  assert.equal(ledger.unchanged(first, 'phone'), true, 'an unchanged state stays held; a new connection sends it again');
});

test('the plain and the enriched copy of one Mesh generation are both recognised', () => {
  const ledger = new RetainedStateLedger(() => 0);
  const snapshot = (detail: string): Payload => ({ type: 'mesh.snapshot', sessionId: 'project-session', projectId: 'project-1',
    generatedAt: 5, project: { projectId: 'project-1', name: detail } } as unknown as Payload);
  const plain = snapshot('plain'), enriched = snapshot('enriched');
  ledger.remember(plain, 'phone');
  ledger.remember(enriched, 'phone');
  assert.equal(ledger.unchanged(plain, 'phone'), true);
  assert.equal(ledger.unchanged(enriched, 'phone'), true);
  ledger.forget();
  assert.equal(ledger.unchanged(enriched, 'phone'), false, 'a new connection starts with nothing handed over');
});

test('commands and history pages are never treated as kept state', () => {
  const ledger = new RetainedStateLedger(() => 0);
  const page = { ...activity(1), history: { requestedCursor: 'older', hasMore: false } } as Payload;
  const command = { type: 'agent.event', kind: 'status', text: 'x', createdAt: 1 } as Payload;
  for (const payload of [page, command]) {
    ledger.remember(payload, 'phone');
    assert.equal(ledger.unchanged(payload, 'phone'), false);
  }
});

let now = 0;
test('a Mesh snapshot that only changed when it was looked at is not sent again', () => {
  const ledger = new RetainedStateLedger(() => now);
  const models = (order: number[], seen: number) => order.map((n) => ({ provider: n % 2 ? 'claude' : 'codex',
    modelId: `model-${n}`, endpointId: 'mac', source: 'native', observedAt: seen }));
  const snapshot = (generatedAt: number, order: number[], used: number, extra?: string): Payload => ({
    type: 'mesh.snapshot', sessionId: 'project-session', projectId: 'project-1', generatedAt,
    project: { projectId: 'project-1', name: extra ?? 'Shop' },
    modelCatalog: [{ endpointId: 'mac', observedAt: generatedAt, models: models(order, generatedAt),
      accountUsage: [{ provider: 'claude', windows: [{ id: 'week', usedPercent: used }] }] }],
  } as unknown as Payload);
  ledger.remember(snapshot(1, [1, 2, 3], 10), 'phone');
  assert.equal(ledger.unchanged(snapshot(2, [3, 1, 2], 10), 'phone'), true,
    'new times and another model order say nothing new about the project');
  assert.equal(ledger.unchanged(snapshot(2, [3, 1, 2], 11), 'phone'), true, 'new usage waits a while');
  now = RETAINED_REFRESH_MS;
  assert.equal(ledger.unchanged(snapshot(5, [3, 1, 2], 10), 'phone'), true, 'unchanged usage never needs a resend');
  assert.equal(ledger.unchanged(snapshot(5, [3, 1, 2], 11), 'phone'), false, 'after five minutes new usage goes');
  assert.equal(ledger.unchanged(snapshot(3, [1, 2, 3, 4], 10), 'phone'), false, 'a new model is news');
  assert.equal(ledger.unchanged(snapshot(4, [1, 2, 3], 10, 'Shop 2'), 'phone'), false, 'a renamed project is news');
  now = 0;
  assert.deepEqual(comparableMeshState({ list: [3, 1], at: { observedAt: 5, keep: true }, accountUsage: [1] }),
    { list: [3, 1], at: { keep: true } }, 'only model lists are reordered');
  assert.deepEqual(comparableMeshState({ accountUsage: [{ observedAt: 1, used: 2 }] }, true), { accountUsage: [{ used: 2 }] });
});
