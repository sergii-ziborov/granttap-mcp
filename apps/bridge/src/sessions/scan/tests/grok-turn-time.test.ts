import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { grokActivity, scanGrok } from '../grok';

test('Grok follow-up answers follow their actual native prompt, retaining existing entry identities', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-grok-clock-'));
  const directory = join(root, 'project', 'native');
  mkdirSync(directory, { recursive: true });
  const previous = process.env.GRANTTAP_GROK_SESSIONS_DIR;
  process.env.GRANTTAP_GROK_SESSIONS_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_GROK_SESSIONS_DIR;
    else process.env.GRANTTAP_GROK_SESSIONS_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const now = Date.now(), old = now - 12 * 60 * 60_000;
  writeFileSync(join(directory, 'summary.json'), JSON.stringify({ info: { id: 'native' },
    created_at: new Date(old).toISOString(), updated_at: new Date(now).toISOString() }));
  const rows = [
    { type: 'user', prompt_index: 0, content: 'Initial request' },
    { type: 'assistant', content: 'Initial answer' },
    { type: 'user', prompt_index: 1, content: 'Follow-up request' },
    { type: 'assistant', content: 'Visible follow-up answer' },
  ];
  writeFileSync(join(directory, 'chat_history.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
  const baseline = grokActivity(scanGrok().sessions[0]!, true);
  writeFileSync(join(directory, 'rewind_points.jsonl'), [
    { prompt_index: 0, created_at: new Date(old + 1_000).toISOString(), file_snapshots: {} },
    { prompt_index: 1, created_at: new Date(now - 10_000).toISOString(), file_snapshots: {} },
  ].map(row => JSON.stringify(row)).join('\n'));
  writeFileSync(join(directory, 'events.jsonl'), JSON.stringify({
    type: 'turn_ended', outcome: 'completed', ts: new Date(now).toISOString(),
  }) + '\n');
  const updated = grokActivity(scanGrok().sessions[0]!, true);
  assert.deepEqual(updated.map(row => row.id), baseline.map(row => row.id),
    'Correcting clocks must replace cached entries rather than duplicate the old history');
  assert.equal(updated[2]!.createdAt, now - 10_000);
  assert.ok(updated[3]!.createdAt >= updated[2]!.createdAt);
  assert.equal(updated[3]!.kind, 'final', 'A completed native answer releases the delivery progress');
  assert.equal(updated[3]!.text, 'Visible follow-up answer');
});
