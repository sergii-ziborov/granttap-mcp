import assert from 'node:assert/strict';
import test from 'node:test';
import type { Payload } from '../../../protocol/schema';
import { RETAINED_REFRESH_MS, RetainedStateLedger } from '../ledger';

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
  assert.equal(ledger.unchanged(first, 'phone'), false, 'after a while the copy is refreshed in case the relay lost it');
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
