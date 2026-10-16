import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptWhenStarted, PHONE_RUN_LIMIT_MS } from '../acceptance';

type Result = { ok: boolean; text?: string; error?: string };

test('a run that fails at once is still reported as that failure', async () => {
  const finished: Result[] = [];
  const early = await acceptWhenStarted(Promise.resolve<Result>({ ok: false, error: 'paused' }),
    async result => { finished.push(result); }, 50);
  assert.deepEqual(early, { ok: false, error: 'paused' });
  assert.deepEqual(finished, [], 'an early result is the caller\'s to report');
});

test('a run still going after the acceptance window counts as delivered and finishes later', async () => {
  let complete!: (result: Result) => void;
  const run = new Promise<Result>(resolve => { complete = resolve; });
  const finished: Result[] = [];
  const early = await acceptWhenStarted(run, async result => { finished.push(result); }, 10);
  assert.equal(early, 'started', 'the agent took the message; the person is not left waiting for the whole turn');
  complete({ ok: true, text: 'Done after a long turn' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(finished, [{ ok: true, text: 'Done after a long turn' }]);
});

test('a late failure is handed to the finisher instead of rejecting the delivery', async () => {
  let complete!: (result: Result) => void;
  const run = new Promise<Result>(resolve => { complete = resolve; });
  const finished: Result[] = [];
  assert.equal(await acceptWhenStarted(run, async result => { finished.push(result); }, 10), 'started');
  complete({ ok: false, error: 'provider exited' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(finished, [{ ok: false, error: 'provider exited' }]);
});

test('a long turn is not cut off at ten minutes', () => {
  assert.ok(PHONE_RUN_LIMIT_MS >= 60 * 60_000);
});
