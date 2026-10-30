import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { captureTransferContext } from '../context';
import { scanGrok, grokActivity } from '../../sessions/scan/grok';
import type { TaskCapsule } from '../../../../../packages/protocol/schema';

test('Grok transfer preserves long messages, thousands of tools and a native image after the display was bounded', async t => {
  const root = mkdtempSync(join(tmpdir(), 'grok-complete-transfer-'));
  const directory = join(root, 'project', 'complete-session');
  mkdirSync(directory, { recursive: true });
  const previous = process.env.GRANTTAP_GROK_SESSIONS_DIR;
  const previousConfig = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_GROK_SESSIONS_DIR = root;
  process.env.GRANTTAP_CONFIG_DIR = join(root, 'granttap');
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_GROK_SESSIONS_DIR;
    else process.env.GRANTTAP_GROK_SESSIONS_DIR = previous;
    if (previousConfig === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previousConfig;
    rmSync(root, { recursive: true, force: true });
  });
  const now = Date.now() - 1000;
  writeFileSync(join(directory, 'summary.json'), JSON.stringify({ info: { id: 'complete-session' },
    created_at: new Date(now - 1000).toISOString(), updated_at: new Date(now).toISOString() }));
  writeFileSync(join(directory, 'chat_history.jsonl'), '\n');
  const row = (update: object) => JSON.stringify({ timestamp: now, method: 'session/update',
    params: { sessionId: 'complete-session', update } }) + '\n';
  const original = 'Original request '.repeat(6000).trim();
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=';
  const rows = [row({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: original } }),
    row({ sessionUpdate: 'user_message_chunk', content: { type: 'image', data: image, mimeType: 'image/png' } }),
    row({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hidden reasoning sentinel' } })];
  for (let index = 0; index < 4200; index++) {
    rows.push(row({ sessionUpdate: 'tool_call', toolCallId: `tool-${index}`,
      rawInput: { target_file: `file-${index}.txt` }, _meta: { 'x.ai/tool': { name: 'read_file' } } }));
    rows.push(row({ sessionUpdate: 'tool_call_update', toolCallId: `tool-${index}`, status: 'completed' }));
  }
  writeFileSync(join(directory, 'updates.jsonl'), rows.join(''));
  const session = scanGrok().sessions[0]!;
  grokActivity(session);
  const capsule: TaskCapsule = { taskId: 'task', goal: 'Continue', currentStatus: 'idle',
    sourceProvider: 'grok', targetProvider: 'claude', sourceComputer: 'mac', targetComputer: 'mac',
    repository: 'repo', baseSha: 'a'.repeat(40), filesChanged: [], dependencies: [], resourceClaims: [],
    remainingWork: [], importantDecisions: [], createdAt: now };
  const captured = await captureTransferContext({ ...session, state: 'idle' }, capsule);
  const archive = JSON.parse(captured.context);
  assert.equal(archive.entries[0].text, original);
  assert.equal(archive.entries.filter((entry: { role: string }) => entry.role === 'tool').length, 4200);
  assert.equal(archive.entries.flatMap((entry: { images?: unknown[] }) => entry.images ?? []).length, 1);
  assert.ok(captured.context.includes(image));
  assert.ok(!captured.context.includes('hidden reasoning sentinel'));
});
