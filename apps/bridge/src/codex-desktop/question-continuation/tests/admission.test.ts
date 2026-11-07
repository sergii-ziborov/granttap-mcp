import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { continueCodexQuestion } from '../../index';

function isolated(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-question-admission-'));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true }); });
}

test('stable question admission survives another caller and rejects changed answers', async t => {
  isolated(t);
  let starts = 0;
  const run = async () => { starts++; return { ok: true as const, text: 'Synthetic completion' }; };
  const options = { messageId: 'synthetic-question', intentDigest: 'synthetic-intent' };
  assert.equal((await continueCodexQuestion('synthetic-chat', options, run)).ok, true);
  const repeated = await continueCodexQuestion('synthetic-chat', options, run);
  assert.deepEqual(repeated, { ok: true, text: '', sessionId: 'synthetic-chat', delivery: 'native' });
  const changed = await continueCodexQuestion('synthetic-chat', { ...options, intentDigest: 'changed' }, run);
  assert.equal(changed.ok, false);
  assert.equal(starts, 1);
});

test('incomplete identities, an uncertain run and concurrent controllers never start a second writer', async t => {
  isolated(t);
  let starts = 0;
  const run = async () => { starts++; throw Error('Synthetic crash after dispatch'); };
  for (const options of [{}, { messageId: 'synthetic-question' }, { intentDigest: 'synthetic-intent' }]) {
    assert.equal((await continueCodexQuestion('synthetic-chat', options, run)).ok, false);
  }
  assert.equal(starts, 0);
  const options = { messageId: 'synthetic-question', intentDigest: 'synthetic-intent' };
  const results = await Promise.all([
    continueCodexQuestion('synthetic-chat', options, run),
    continueCodexQuestion('synthetic-chat', options, run),
  ]);
  assert.ok(results.every(result => !result.ok && result.delivery === 'native'));
  assert.equal(starts, 1);
  assert.equal((await continueCodexQuestion('synthetic-chat', options, run)).ok, false);
  assert.equal(starts, 1);
});
