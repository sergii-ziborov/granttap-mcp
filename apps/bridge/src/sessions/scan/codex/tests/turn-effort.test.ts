import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCodexFile } from '../parse';

test('native Codex turn effort is observed explicitly and disappears when the next turn does not report it', () => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-native-effort-'));
  try {
    const path = join(root, 'rollout.jsonl');
    const line = (type: string, payload: unknown) => JSON.stringify({ timestamp: Date.now(), type, payload }) + '\n';
    writeFileSync(path, line('session_meta', { id: 'native-effort-fixture', cwd: '/fixture' })
      + line('turn_context', { model: 'native-model', effort: 'high' }));
    assert.equal(parseCodexFile(path)?.session.effort, 'high');
    appendFileSync(path, line('turn_context', { model: 'native-model' }));
    assert.equal(parseCodexFile(path)?.session.effort, undefined);
    appendFileSync(path, line('turn_context', { model: 'native-model', reasoning_effort: 'ultra' }));
    assert.equal(parseCodexFile(path)?.session.effort, 'ultra');
    appendFileSync(path, line('turn_context', { model: 'native-model', effort: 'unsupported' }));
    assert.equal(parseCodexFile(path)?.session.effort, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
