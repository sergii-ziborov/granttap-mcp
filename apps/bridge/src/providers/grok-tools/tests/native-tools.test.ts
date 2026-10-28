import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { grokToolCalls, grokToolCompletions, grokToolSummary, grokRecordedChanges } from '../index';

test('Grok normalizes both contracts, bounds calls, and never summarizes malformed raw arguments', () => {
  const calls = grokToolCalls({ content: [{ type: 'tool_use', id: 'same', name: 'Read', input: { path: 'a.go' } }],
    tool_calls: [
      { id: 'same', name: 'Read', arguments: { path: 'a.go' } },
      { id: 'wrapped', function: { name: 'read_file', arguments: '{"target_file":"b.go"}' } },
      { id: 'bad', name: 'tool', arguments: '{private payload' },
      null, { name: '' }, { name: 'x'.repeat(241) },
    ] });
  assert.deepEqual(calls.map(call => call.id), ['same', 'wrapped', 'bad']);
  assert.match(grokToolSummary(calls[1]!), /b\.go/);
  assert.equal(grokToolSummary(calls[2]!), 'tool');
  assert.equal(grokToolCalls({ tool_calls: Array.from({ length: 100 }, (_, i) => ({ id: String(i), name: 'tool' })) }).length, 64);
});

test('native completion is scoped to its directory and survives only complete current log records', t => {
  const a = mkdtempSync(join(tmpdir(), 'granttap-grok-completion-'));
  const b = mkdtempSync(join(tmpdir(), 'granttap-grok-other-'));
  t.after(() => { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); });
  const path = join(a, 'events.jsonl'), at = new Date(Date.now() - 1_000).toISOString();
  const event = JSON.stringify({ type: 'tool_completed', tool_call_id: 'call', tool_name: 'search_replace', outcome: 'success', ts: at });
  writeFileSync(path, event.slice(0, 50));
  assert.equal(grokToolCompletions(a).size, 0);
  appendFileSync(path, event.slice(50) + '\n');
  assert.equal(grokToolCompletions(a).get('call')?.outcome, 'success');
  assert.equal(grokToolCompletions(b).size, 0);
  appendFileSync(path, JSON.stringify({ type: 'tool_completed', tool_call_id: 'call', tool_name: 'search_replace',
    outcome: 'error', ts: new Date().toISOString() }) + '\n');
  assert.equal(grokToolCompletions(a).get('call')?.outcome, 'error');
  writeFileSync(path, '{}\n');
  assert.equal(grokToolCompletions(a).size, 0, 'Truncating a log removes stale successful calls');
});

test('recorded changes reject mismatched tools, unsafe paths, replace-all and unconfirmed results', () => {
  const call = { id: 'edit', name: 'search_replace', typed: true, ordinal: 0,
    input: { file_path: 'source.go', old_string: 'a\n', new_string: 'b\n' } };
  const success = { name: 'search_replace', outcome: 'success', at: Date.now() };
  assert.equal(grokRecordedChanges(call, undefined).length, 0);
  assert.equal(grokRecordedChanges(call, { ...success, name: 'read_file' }).length, 0);
  assert.equal(grokRecordedChanges(call, { ...success, outcome: 'error' }).length, 0);
  for (const path of ['.env', '../outside.go', 'bad\nname.go', 'secret.key']) {
    assert.equal(grokRecordedChanges({ ...call, input: { ...call.input, file_path: path } }, success).length, 0);
  }
  assert.equal(grokRecordedChanges({ ...call, input: { ...call.input, replace_all: true } }, success).length, 0);
  assert.equal(grokRecordedChanges(call, success)[0]?.path, 'source.go');
});
