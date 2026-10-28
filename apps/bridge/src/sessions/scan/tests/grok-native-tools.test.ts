import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { grokActivity, grokCapabilityUsage, scanGrok } from '../grok';

function fixture(t: TestContext, rows: unknown[], events: unknown[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-grok-native-tools-'));
  const directory = join(root, 'project', 'tools-session');
  mkdirSync(directory, { recursive: true });
  const previous = process.env.GRANTTAP_GROK_SESSIONS_DIR;
  process.env.GRANTTAP_GROK_SESSIONS_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_GROK_SESSIONS_DIR;
    else process.env.GRANTTAP_GROK_SESSIONS_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const at = Date.now() - 1_000;
  writeFileSync(join(directory, 'summary.json'), JSON.stringify({ info: { id: 'tools-session', cwd: root },
    created_at: new Date(at).toISOString(), updated_at: new Date(at).toISOString() }));
  writeFileSync(join(directory, 'rewind_points.jsonl'), JSON.stringify({ prompt_index: 0,
    created_at: new Date(at).toISOString() }) + '\n');
  writeFileSync(join(directory, 'chat_history.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
  writeFileSync(join(directory, 'events.jsonl'), events.map(row => JSON.stringify(row)).join('\n') + '\n');
  return { directory, session: () => scanGrok().sessions[0]! };
}

test('native Grok tool_calls expose current work and actual capability use alongside legacy tools', t => {
  const { session } = fixture(t, [
    { type: 'user', prompt_index: 0, content: 'Review the example' },
    { type: 'assistant', content: 'Inspecting the file', tool_calls: [
      { id: 'read', name: 'read_file', arguments: { target_file: 'main.go' } },
      { id: 'shell', name: 'run_terminal_command', arguments: JSON.stringify({ command: 'go test ./...' }) },
      { id: 'mcp', name: 'mcp__docs__lookup', arguments: { query: 'Go tests' } },
    ] },
    { type: 'assistant', content: [{ type: 'tool_use', id: 'legacy', name: 'Read', input: { file_path: 'go.mod' } }] },
  ]);
  const current = session(), activity = grokActivity(current, true);
  const calls = activity.filter(row => row.kind === 'tool');
  assert.deepEqual(calls.map(row => row.toolName), ['read_file', 'run_terminal_command', 'mcp__docs__lookup', 'Read']);
  assert.match(calls[0]!.text, /main\.go/);
  assert.match(calls[1]!.text, /go test/);
  assert.equal(new Set(activity.map(row => row.id)).size, activity.length);
  assert.deepEqual(grokActivity(current).map(row => row.id), activity.map(row => row.id));
  assert.equal(grokCapabilityUsage(current).find(row => row.sourceId === 'mcp')?.mcpServer, 'docs');
});

test('Grok file changes require successful native completion for that exact edit call', t => {
  const now = Date.now() - 500;
  const call = (id: string, path: string) => ({ id, name: 'search_replace',
    arguments: { file_path: path, old_string: 'before\n', new_string: 'after\n' } });
  const { directory, session } = fixture(t, [
    { type: 'user', prompt_index: 0, content: 'Update the example' },
    { type: 'assistant', content: '', tool_calls: [
      call('ok', 'main.go'), call('failed', 'failed.go'), call('pending', 'pending.go'), call('secret', '.env'),
    ] },
    { type: 'tool_result', tool_call_id: 'ok', content: 'success is not authoritative by itself' },
  ], [
    { type: 'tool_completed', tool_call_id: 'ok', tool_name: 'search_replace', outcome: 'success', ts: new Date(now).toISOString() },
    { type: 'tool_completed', tool_call_id: 'failed', tool_name: 'search_replace', outcome: 'error', ts: new Date(now).toISOString() },
    { type: 'tool_completed', tool_call_id: 'secret', tool_name: 'search_replace', outcome: 'success', ts: new Date(now).toISOString() },
    { type: 'tool_completed', tool_call_id: 'wrong-id', tool_name: 'search_replace', outcome: 'success', ts: new Date(now).toISOString() },
  ]);
  const before = grokActivity(session(), true);
  assert.deepEqual(before.flatMap(row => row.fileChanges ?? []).map(row => row.path), ['main.go']);
  const change = before.flatMap(row => row.fileChanges ?? [])[0]!;
  assert.equal(change.linesAdded, 1); assert.equal(change.linesRemoved, 1);
  assert.match(change.diff, /-before/); assert.match(change.diff, /\+after/);
  appendFileSync(join(directory, 'events.jsonl'), JSON.stringify({ type: 'tool_completed',
    tool_call_id: 'pending', tool_name: 'search_replace', outcome: 'success', ts: new Date(now + 1).toISOString() }) + '\n');
  const after = grokActivity(session(), true);
  assert.deepEqual(after.map(row => row.id), before.map(row => row.id));
  assert.deepEqual(after.flatMap(row => row.fileChanges ?? []).map(row => row.path), ['main.go', 'pending.go']);
});
