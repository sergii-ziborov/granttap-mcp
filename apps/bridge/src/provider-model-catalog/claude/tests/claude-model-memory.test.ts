import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AdvertisedModel } from '../../../../../../packages/protocol/schema';
import { recallClaudeModels, rememberClaudeModels } from '../claude-model-memory';

const digest = (n: number) => n.toString(16).padStart(64, '0');
const row = (modelId: string, extra: Partial<AdvertisedModel> = {}): AdvertisedModel => ({ modelId, provider: 'claude',
  endpointId: 'mac', source: 'advertised', observedAt: 5, label: `${modelId} label`, ...extra });

test('a kept answer keeps only bounded picker rows and the newest four answers', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-claude-memory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'claude-models.json');
  for (let n = 1; n <= 5; n += 1) {
    rememberClaudeModels(path, { identity: digest(n), scope: digest(100 + n),
      rows: [row('opus', { priority: 0, supportedEfforts: ['low', 'high'], description: 'For complex work' })] });
  }
  assert.equal(recallClaudeModels(path, digest(1), 'mac'), undefined, 'only the newest four answers are kept');
  const kept = recallClaudeModels(path, digest(5), 'other-endpoint')!;
  assert.equal(kept.scope, digest(105));
  assert.deepEqual(kept.rows, [{ modelId: 'opus', provider: 'claude', endpointId: 'other-endpoint', source: 'advertised',
    observedAt: 5, label: 'opus label', description: 'For complex work', priority: 0, supportedEfforts: ['low', 'high'] }]);
  rememberClaudeModels(path, { identity: digest(5), scope: digest(205), rows: [row('sonnet')] });
  assert.deepEqual(recallClaudeModels(path, digest(5), 'mac')!.rows.map(item => item.modelId), ['sonnet'],
    'a newer answer of the same Claude Code and account replaces its older one');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).answers.length, 4);
});

test('malformed kept rows are dropped one by one, and a malformed answer is none', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-claude-memory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'claude-models.json');
  writeFileSync(path, JSON.stringify({ answers: [
    { identity: digest(1), scope: digest(2), rows: [null, { modelId: 'bad id', observedAt: 1 }, { modelId: 'opus' },
      { modelId: 'opus', observedAt: 1, label: 'x'.repeat(161), description: 7, priority: 1.5,
        supportedEfforts: ['high', 'future', null] }] },
    { identity: digest(3), scope: 'not a digest', rows: [{ modelId: 'opus', observedAt: 1 }] },
    { identity: digest(4), scope: digest(5), rows: [{ modelId: 'opus' }] },
    { identity: digest(6), scope: digest(7), rows: 'opus' }] }));
  assert.deepEqual(recallClaudeModels(path, digest(1), 'mac')!.rows, [{ modelId: 'opus', provider: 'claude',
    endpointId: 'mac', source: 'advertised', observedAt: 1, label: undefined, description: undefined,
    supportedEfforts: ['high'] }]);
  for (const identity of [digest(3), digest(4), digest(6), digest(9)]) {
    assert.equal(recallClaudeModels(path, identity, 'mac'), undefined);
  }
  writeFileSync(path, JSON.stringify({ answers: 'none' }));
  assert.equal(recallClaudeModels(path, digest(1), 'mac'), undefined);
});

test('an answer that cannot be written costs nothing but the next restart its names', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-claude-memory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'file'), '');
  const path = join(root, 'file', 'claude-models.json');
  assert.doesNotThrow(() => rememberClaudeModels(path, { identity: digest(1), scope: digest(2), rows: [row('opus')] }));
  assert.equal(recallClaudeModels(path, digest(1), 'mac'), undefined);
});
