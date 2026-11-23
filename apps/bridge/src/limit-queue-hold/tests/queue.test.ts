import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMIT_CONTINUE_PROMPT } from '../../limit-continuation';
import { CHAT, NOW, RESET, computer, going, hour, limited, minute } from './queue-fixture';

const AFTER_RESET = RESET + minute + 1_000;
const phases = (f: ReturnType<typeof computer>) => f.inbox().pendingRecords().map(record => record.phase);

test('three messages queued while a limit holds the chat stay queued, then follow its continuation one at a time', async t => {
  const f = computer(t);
  f.start();
  const continuation = (await f.continuation())!;
  f.queue(f.job('a', 'First', NOW), f.job('b', 'Second', NOW + 1), f.job('c', 'Third', NOW + 2));
  await f.settle();
  assert.deepEqual(f.delivered, [], 'before this, each one started a run the same limit refused at once');
  assert.deepEqual(phases(f), ['staged', 'staged', 'staged'], 'kept: neither started, dropped nor failed');
  f.at(NOW + 2 * hour);
  await f.settle();
  assert.deepEqual(f.delivered, []);
  f.at(AFTER_RESET);
  await f.settle();
  assert.deepEqual(f.delivered, [], 'after the reset they wait for the continuation, which the relay offers at its time');
  f.queue(continuation);
  await f.until(1);
  assert.equal(f.delivered[0], LIMIT_CONTINUE_PROMPT);
  await f.settle();
  assert.equal(f.delivered.length, 1, 'the queue waits for the continued turn');
  for (const count of [2, 3, 4]) { f.chat(going('idle', Date.now())); await f.until(count); }
  assert.deepEqual(f.delivered, [LIMIT_CONTINUE_PROMPT, 'First', 'Second', 'Third'], 'one continuation, then the order kept');
  assert.equal(f.lines.length, 2, f.lines.join('\n'));
  assert.match(f.lines[0]!, new RegExp(`chat ${CHAT.slice(0, 8)} wait for its 5-hour limit \\(reset 2026-11-23 13:00 UTC\\): `
    + 'they go one at a time after the reset\\.$'));
  assert.match(f.lines[1]!, /go on after its 5-hour limit .*: its continuation went first\.$|go on: its continuation went first\.$/);
});

test('with continuing turned off nothing continues the chat, and the queue goes in order after the reset', async t => {
  const f = computer(t);
  f.chat(limited(RESET, NOW - minute, false));
  f.start();
  assert.equal(await f.continuation(true), undefined);
  f.queue(f.job('a', 'First', NOW), f.job('b', 'Second', NOW + 1), f.job('c', 'Third', NOW + 2));
  await f.settle();
  f.at(RESET + 30_000);
  await f.settle();
  assert.deepEqual(f.delivered, [], 'a minute of grace after the stated reset, as for a continuation');
  f.at(AFTER_RESET);
  await f.until(1);
  for (const count of [2, 3]) { f.chat(going('idle', Date.now())); await f.until(count); }
  assert.deepEqual(f.delivered, ['First', 'Second', 'Third']);
  assert.deepEqual(f.continuations, [], 'no continuation was queued');
  assert.match(f.lines.at(-1)!, /: the limit reset\.$/);
});

test('refused again after the reset, the queue waits again: one more try a quarter of an hour later, across a restart', async t => {
  const f = computer(t);
  f.chat(limited(RESET, NOW - minute, false));
  f.start();
  await f.continuation(true);
  f.queue(f.job('a', 'First', NOW), f.job('b', 'Second', NOW + 1), f.job('c', 'Third', NOW + 2));
  f.at(AFTER_RESET);
  await f.until(1);
  const refusedAt = AFTER_RESET + 5_000;
  f.at(refusedAt);
  f.chat(limited(RESET, refusedAt, false));
  await f.settle();
  assert.equal(f.delivered.length, 1, 'the next message does not follow into the same refusal');
  assert.match(f.lines.at(-1)!, /the chat was refused again; the next one goes at 2026-11-23 13:16 UTC\.$/);
  f.start();
  f.at(refusedAt + 14 * minute);
  await f.settle();
  assert.equal(f.delivered.length, 1, 'a restarted monitor knows a message already went after the reset');
  assert.deepEqual(phases(f), ['staged', 'staged']);
  f.at(refusedAt + 15 * minute + 1_000);
  await f.until(2);
  f.chat(going('idle', Date.now()));
  await f.until(3);
  assert.deepEqual(f.delivered, ['First', 'Second', 'Third']);
});

test('a monitor restart or update keeps the queue waiting, announces it once, and keeps the order', async t => {
  const f = computer(t);
  f.start();
  const continuation = (await f.continuation())!;
  f.queue(f.job('a', 'First', NOW), f.job('b', 'Second', NOW + 1));
  await f.settle();
  f.start();
  await f.settle();
  assert.deepEqual(f.delivered, []);
  assert.equal(f.lines.length, 1, 'the new monitor knows the hold was announced');
  f.at(AFTER_RESET);
  f.queue(continuation);
  await f.until(1);
  f.start();
  f.chat(going('idle', Date.now()));
  await f.until(2);
  f.chat(going('idle', Date.now()));
  await f.until(3);
  assert.deepEqual(f.delivered, [LIMIT_CONTINUE_PROMPT, 'First', 'Second']);
});

test('Send now goes at once while the queue waits, and a message cancelled from the phone leaves it', async t => {
  const f = computer(t);
  f.chat(limited(RESET, NOW - minute, false));
  f.start();
  const first = f.job('a', 'First', NOW - 2), second = f.job('b', 'Second', NOW - 1);
  f.queue(first, second, f.job('d', 'Now', NOW, { deliveryMode: 'immediate' }));
  await f.until(1);
  assert.deepEqual(f.delivered, ['Now'], 'the person released it; only the queued ones wait');
  f.chat(limited(RESET, Date.now(), false));
  f.relay.set(second.jobId, 'cancelled');
  f.at(NOW + 11 * minute);
  await f.settle();
  assert.deepEqual(f.inbox().pendingRecords().map(record => record.job.jobId), [first.jobId]);
  f.at(AFTER_RESET);
  await f.until(2);
  assert.deepEqual(f.delivered, ['Now', 'First']);
});
