import assert from 'node:assert/strict';
import test from 'node:test';
import { runProcess } from '../process';

test('a stalled startup ends before the long execution budget', async () => {
  const started = Date.now();
  const result = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
    undefined, 5_000, () => ({ ok: true, text: 'unused' }), undefined, undefined,
    { confirmed: () => false, withinMs: 80, timeoutMessage: 'Receipt not confirmed.' });
  assert.deepEqual(result, { ok: false, error: 'Receipt not confirmed.' });
  assert.ok(Date.now() - started < 2_000, 'opening a provider cannot consume the whole run budget');
});

test('confirmed provider activity keeps the execution budget and survives a timeout as native delivery', async () => {
  const result = await runProcess(process.execPath,
    ['-e', 'process.stdout.write("accepted");setInterval(()=>{},1000)'], undefined, 2_000,
    () => ({ ok: true, text: 'unused' }), undefined, undefined,
    { confirmed: (stdout: string) => stdout === 'accepted', withinMs: 1_000,
      timeoutMessage: 'Receipt not confirmed.' });
  assert.equal(result.ok, false);
  assert.equal(result.delivery, 'native');
  assert.ok(!result.ok && result.error.includes('did not respond within'));
});

test('confirmed stream activity reports admission once before the turn finishes', async () => {
  let callbacks = 0, settled = false, early = false;
  const result = await runProcess(process.execPath, ['-e',
    'process.stdout.write("accepted");setTimeout(()=>process.stdout.write("accepted"),50);setTimeout(()=>process.exit(0),150)'],
    undefined, 2_000, () => ({ ok: true, text: 'Done' }), undefined, undefined,
    { confirmed: (stdout: string) => stdout.includes('accepted'), withinMs: 1_000,
      timeoutMessage: 'No admission', onConfirmed: () => { callbacks++; early = !settled; } });
  settled = true;
  assert.equal(result.ok, true);
  assert.equal(callbacks, 1);
  assert.equal(early, true);
});
