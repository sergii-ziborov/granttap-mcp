import assert from 'node:assert/strict';
import test from 'node:test';
import { oldestDeliveryStartedAt } from '../..';
import { queued } from '../../in-flight';
import type { ReplyResult } from '../../payload/types';

function run() {
  let end = () => {};
  const result = new Promise<ReplyResult>(resolve => { end = () => resolve({ ok: true, text: 'Synthetic answer' }); });
  return { result, end: () => end() };
}

test('the oldest owned run is known from the moment its chat is taken until that chat has nothing left', async () => {
  assert.equal(oldestDeliveryStartedAt(), undefined);
  const before = Date.now(), long = run(), followUp = run(), other = run();
  const first = queued('oldest-run-chat-a', () => long.result);
  const startedAt = oldestDeliveryStartedAt();
  assert.ok(startedAt !== undefined && startedAt >= before && startedAt <= Date.now());
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = queued('oldest-run-chat-a', () => followUp.result);
  const third = queued('oldest-run-chat-b', () => other.result);
  assert.equal(oldestDeliveryStartedAt(), startedAt, 'a newer chat does not hide the longest run');
  long.end(); await first;
  assert.equal(oldestDeliveryStartedAt(), startedAt, 'a follow-up admitted behind it belongs to the same wait');
  followUp.end(); await second;
  assert.ok(oldestDeliveryStartedAt()! > startedAt, 'what runs now began later');
  other.end(); await third;
  assert.equal(oldestDeliveryStartedAt(), undefined);
});
