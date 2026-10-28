import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readGrokConversation } from '../index';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'grok-conversation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'updates.jsonl');
  const row = (update: object, sessionId = 'native') => JSON.stringify({ timestamp: Date.now() - 100,
    method: 'session/update', params: { sessionId, update } }) + '\n';
  return { root, path, row };
}

test('native updates are authoritative even when empty and never expose another session', t => {
  const { root, path, row } = fixture(t);
  writeFileSync(path, row({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Native answer' } }));
  assert.equal(readGrokConversation(root, 'native', true)?.[0]?.text, 'Native answer');
  assert.deepEqual(readGrokConversation(root, 'different', true), []);
  writeFileSync(path, '');
  assert.deepEqual(readGrokConversation(root, 'native', true), []);
});

test('incremental chunks retain spaces, UTF-8 and identities; unfinished records block complete capture', t => {
  const { root, path, row } = fixture(t);
  writeFileSync(path, row({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Привет ' } }));
  const identity = readGrokConversation(root, 'native', true)![0]!.id;
  const next = Buffer.from(row({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'мир' } }));
  appendFileSync(path, next.subarray(0, next.length - 2));
  assert.throws(() => readGrokConversation(root, 'native', true), /complete|bound|written/);
  appendFileSync(path, next.subarray(next.length - 2));
  assert.deepEqual(readGrokConversation(root, 'native', true)?.map(entry => [entry.id, entry.text]), [[identity, 'Привет мир']]);
  writeFileSync(path, row({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Replacement' } }));
  assert.equal(readGrokConversation(root, 'native', true)?.[0]?.text, 'Replacement');
});

test('completed tool metadata eviction does not truncate a complete multi-hundred-tool conversation', t => {
  const { root, path, row } = fixture(t);
  const lines: string[] = [];
  for (let index = 0; index < 300; index++) {
    lines.push(row({ sessionUpdate: 'tool_call', toolCallId: `call-${index}`,
      rawInput: { target_file: `sample-${index}.txt` }, _meta: { 'x.ai/tool': { name: 'read_file' } } }));
    lines.push(row({ sessionUpdate: 'tool_call_update', toolCallId: `call-${index}`, status: 'completed' }));
  }
  writeFileSync(path, lines.join(''));
  assert.equal(readGrokConversation(root, 'native', true)?.length, 300);
});

test('malformed input and unrecoverable image content refuse complete transfer capture', t => {
  const { root, path, row } = fixture(t);
  writeFileSync(path, '{malformed}\n');
  assert.throws(() => readGrokConversation(root, 'native', true), /complete|bound|written/);
  writeFileSync(path, row({ sessionUpdate: 'user_message_chunk', content: { type: 'image', data: 'AQID' } }));
  assert.throws(() => readGrokConversation(root, 'native', true), /complete|bound|written/);
});
