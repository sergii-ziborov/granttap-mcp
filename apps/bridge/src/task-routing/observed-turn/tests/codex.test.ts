import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLatestCodexTurnControls } from '../codex';

test('offload reads the latest native model and effort beyond bounded catalog windows without materializing giant message rows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-routing-turn-controls-'));
  try {
    const path = join(root, 'rollout.jsonl');
    const context = (model: string, effort?: string) => JSON.stringify({ type: 'turn_context', payload: { model, effort } }) + '\n';
    const large = JSON.stringify({ type: 'response_item', payload: { text: 'Synthetic'.repeat(150_000) } }) + '\n';
    writeFileSync(path, context('old-model', 'low') + large + context('current-model', 'high') + large);
    assert.deepEqual(await readLatestCodexTurnControls(path), { model: 'current-model', effort: 'high' });
    assert.equal(await readLatestCodexTurnControls(path, 1_024), undefined, 'A missing bounded observation never falls back to an old guess.');
    appendFileSync(path, context('new-model'));
    assert.deepEqual(await readLatestCodexTurnControls(path), { model: 'new-model', effort: undefined });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
