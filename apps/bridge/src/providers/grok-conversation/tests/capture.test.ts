import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { captureGrokConversation } from '../capture';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'grok-full-capture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'updates.jsonl');
  const row = (update: object, sessionId = 'native') => JSON.stringify({ timestamp: Date.now() - 100,
    method: 'session/update', params: { sessionId, update } }) + '\n';
  return { root, path, row };
}

test('complete capture distinguishes an absent transcript, an empty transcript and unfinished data', async t => {
  const { root, path, row } = fixture(t);
  assert.equal(await captureGrokConversation(root, 'native'), undefined);
  writeFileSync(path, '');
  assert.deepEqual((await captureGrokConversation(root, 'native'))?.entries, []);
  writeFileSync(path, row({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'whole' } }).trim());
  await assert.rejects(captureGrokConversation(root, 'native'), /written|partial/);
  appendFileSync(path, '\n');
  const captured = await captureGrokConversation(root, 'native');
  assert.equal(captured?.entries[0]?.text, 'whole');
  assert.equal(captured?.unchanged(), true);
  appendFileSync(path, row({ sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }));
  assert.equal(captured?.unchanged(), false);
});

test('complete capture refuses malformed or oversized raw input before claiming an archive', async t => {
  const { root, path } = fixture(t);
  writeFileSync(path, '{malformed}\n');
  await assert.rejects(captureGrokConversation(root, 'native'), /unrecoverable/);
  truncateSync(path, 512 * 1024 * 1024 + 1);
  await assert.rejects(captureGrokConversation(root, 'native'), /budget/);
});

test('invalid images refuse a complete transfer and synthetic images never enter one', async t => {
  const { root, path, row } = fixture(t);
  writeFileSync(path, row({ sessionUpdate: 'user_message_chunk',
    content: { type: 'image', data: 'AQID', mimeType: 'image/png' } }));
  await assert.rejects(captureGrokConversation(root, 'native'), /unrecoverable/);
  writeFileSync(path, row({ sessionUpdate: 'user_message_chunk', _meta: { syntheticReason: 'compaction' },
    content: { type: 'image', data: 'AQID', mimeType: 'image/png' } }));
  const captured = await captureGrokConversation(root, 'native');
  assert.deepEqual(captured?.entries, []);
  assert.equal(captured?.image({}, 'missing', 0), undefined);
});

test('a complete projection has its own enforced context budget', async t => {
  const { root, path, row } = fixture(t);
  writeFileSync(path, Array.from({ length: 5 }, (_, index) => row({ sessionUpdate: 'user_message_chunk',
    _meta: { promptIndex: index }, content: { type: 'text', text: 'x'.repeat(4_000_000) } })).join(''));
  await assert.rejects(captureGrokConversation(root, 'native'), /budget/);
});
