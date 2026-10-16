import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { scanThreadActivity } from '../index';
import { scanClaude } from '../scan/claude';

test('opening a Claude child reads a bounded recent window and keeps its native identity', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-thread-window-'));
  const before = process.env.GRANTTAP_CLAUDE_PROJECTS_DIR;
  process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = root;
  t.after(() => {
    if (before === undefined) delete process.env.GRANTTAP_CLAUDE_PROJECTS_DIR;
    else process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = before;
    rmSync(root, { recursive: true, force: true });
  });
  const id = 'bounded-parent', childId = 'native-child';
  const folder = join(root, 'project', id, 'subagents');
  mkdirSync(folder, { recursive: true });
  const row = (uuid: string, text: string) => JSON.stringify({ type: 'assistant', uuid,
    sessionId: id, agentId: childId, timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text }] } });
  writeFileSync(join(root, 'project', `${id}.jsonl`), row('parent', 'Synthetic parent') + '\n');
  // Native agentId need not match the log filename.
  writeFileSync(join(folder, 'agent-file-name.jsonl'), [row('old', 'x'.repeat(2 * 1024 * 1024)),
    row('recent-one', 'Recent child answer'), row('recent-two', 'Newest child answer')].join('\n') + '\n');
  const parent = scanClaude().sessions.find(value => value.sessionId === id)!;
  const result = scanThreadActivity(parent, childId);
  assert.deepEqual(result.entries.map(value => value.text), ['Recent child answer', 'Newest child answer']);
  assert.equal(result.entries.every(value => value.childThreadId === childId), true);
  assert.deepEqual(scanThreadActivity(parent, 'unknown-child').entries, []);
});
