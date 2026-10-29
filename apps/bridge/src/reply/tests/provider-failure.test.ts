import assert from 'node:assert/strict';
import test from 'node:test';
import { runProcess } from '../process';

test('a real Grok balance refusal is returned promptly as a usage error without invented admission', async () => {
  const refusal = 'Error: Internal error: {"message":"API error (status 402 Payment Required): Grok Build usage balance exhausted","http_status":402}';
  const result = await runProcess(process.execPath, ['-e',
    `process.stderr.write(${JSON.stringify(refusal)}); process.exit(1)`], undefined, 5_000,
    () => ({ ok: true, text: 'incorrect success' }), undefined, undefined,
    { confirmed: () => false, withinMs: 4_000, timeoutMessage: 'incorrect timeout' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, 'Grok usage limit reached: Grok Build usage balance exhausted. Check your Grok usage before retrying.');
    assert.equal(result.delivery, undefined);
  }
});

test('a later quota refusal preserves actual earlier agent activity without claiming a successful answer', async () => {
  const result = await runProcess(process.execPath, ['-e',
    'process.stdout.write("accepted"); setTimeout(()=>{process.stderr.write("Grok Build usage balance exhausted");process.exit(1)},50)'],
    undefined, 5_000, () => ({ ok: true, text: 'incorrect success' }), undefined, undefined,
    { confirmed: text => text.includes('accepted'), withinMs: 4_000, timeoutMessage: 'incorrect timeout' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /^Grok usage limit reached:/);
    assert.equal(result.delivery, 'native');
  }
});

test('an unrelated payment diagnostic is not misclassified as Grok account exhaustion', async () => {
  const result = await runProcess(process.execPath, ['-e',
    'process.stderr.write("API error (status 402 Payment Required): fixture payment declined");process.exit(1)'],
    undefined, 5_000, () => ({ ok: true, text: 'incorrect success' }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.doesNotMatch(result.error, /^Grok usage limit reached:/);
});
