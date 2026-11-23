import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SessionInfo } from '../../../../../packages/protocol/schema';
import { compactClaudeSession, readClaudeCompaction } from '../claude';
import { fakeClaude } from './fake-claude';

const lines = (...rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n');

test("Claude Code's own report of a headless /compact gives the context before and after", () => {
  const printed = lines(
    { type: 'system', subtype: 'status', status: 'compacting' },
    { type: 'system', subtype: 'status', status: null, compact_result: 'success' },
    { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 18_717, post_tokens: 3_581 } },
    { type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' } },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 0 },
  );
  assert.deepEqual(readClaudeCompaction(`not json\n${printed}`), { ok: true, preTokens: 18_717, postTokens: 3_581 });
  assert.deepEqual(readClaudeCompaction(lines({ type: 'system', subtype: 'compact_boundary' })), { ok: true },
    'a boundary without sizes still says the compaction happened');
});

test("Claude Code's refusals come back in its own words, never as a compaction", () => {
  assert.deepEqual(readClaudeCompaction(lines({ type: 'system', subtype: 'status', compact_result: 'failed',
    compact_error: '  Not enough\nmessages to compact. ' })), { ok: false, error: 'Not enough messages to compact.' });
  assert.deepEqual(readClaudeCompaction(lines({ type: 'system', subtype: 'status', compact_result: 'failed' })),
    { ok: false, error: 'Claude Code could not compact the conversation.' });
  assert.deepEqual(readClaudeCompaction(lines({ type: 'result', is_error: true, errors: ['No conversation found', 'with id'] })),
    { ok: false, error: 'No conversation found with id' });
  assert.deepEqual(readClaudeCompaction(lines({ type: 'result', is_error: true, result: 'Prompt is too long' })),
    { ok: false, error: 'Prompt is too long' });
  assert.deepEqual(readClaudeCompaction(lines({ type: 'result', is_error: true })), { ok: false, error: 'Claude Code stopped with an error.' });
  assert.deepEqual(readClaudeCompaction(lines({ type: 'user', message: { content: [{ type: 'text',
    text: '<local-command-stdout>Error: nothing to compact</local-command-stdout>' }] } })), { ok: false, error: 'Error: nothing to compact' });
  assert.deepEqual(readClaudeCompaction(''), { ok: false, error: 'Claude Code finished without compacting the conversation.' });
});

test('the compaction is `claude -p --resume <chat> /compact` in the chat folder, and a refusal is kept', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'granttap-compact-folder-'));
  const claude = fakeClaude();
  t.after(() => { claude.done(); rmSync(folder, { recursive: true, force: true }); });
  const session = { sessionId: 'claude-chat-1', agent: 'claude', cwd: folder } as SessionInfo;
  assert.deepEqual(await compactClaudeSession(session), { ok: true, preTokens: 612_002, postTokens: 31_400 });
  const [call] = claude.calls();
  assert.deepEqual(call!.args, ['-p', '--resume', 'claude-chat-1', '--output-format', 'stream-json', '--verbose', '/compact']);
  assert.equal(call!.cwd.endsWith(folder.split('/').at(-1)!), true);

  process.env.FAKE_CLAUDE_MODE = 'failed';
  assert.deepEqual(await compactClaudeSession(session), { ok: false, error: 'Not enough messages to compact.' });
  process.env.FAKE_CLAUDE_MODE = 'missing';
  const missing = await compactClaudeSession(session);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /No conversation found/);
  process.env.FAKE_CLAUDE_MODE = 'success';
  process.env.FAKE_CLAUDE_DELAY_MS = '5000';
  t.after(() => { delete process.env.FAKE_CLAUDE_DELAY_MS; });
  const late = await compactClaudeSession(session, 200);
  assert.equal(late.ok, false);
  if (!late.ok) assert.match(late.error, /did not respond within/);
});
