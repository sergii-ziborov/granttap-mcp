import assert from 'node:assert/strict';
import test from 'node:test';
import { Payload } from '../../../../../packages/protocol/schema';

test('task-encrypted image requests and chunks cross the public wire contract', () => {
  assert.equal(Payload.safeParse({ type: 'session.image.query', sessionId: 'chat',
    requestId: 'request', imageId: 'image', offset: 0, createdAt: 1 }).success, true);
  assert.equal(Payload.safeParse({ type: 'session.image.chunk', sessionId: 'chat',
    requestId: 'request', imageId: 'image', offset: 0, totalBytes: 3,
    mimeType: 'image/png', dataBase64: 'YWJj' }).success, true);
});

test('transcript picture advertisements and full messages survive the wire parser', () => {
  const images = [{ id: 'picture', name: 'diagram.png', markdown: '![Diagram](diagram.png)' }];
  const text = 'complete answer '.repeat(3000);
  const parsed = Payload.parse({ type: 'session.activity', sessionId: 'chat', agent: 'codex',
    state: 'idle', entries: [{ id: 'answer', kind: 'message', text, createdAt: 1, images }],
    generatedAt: 2 });
  assert.equal(parsed.type, 'session.activity');
  if (parsed.type !== 'session.activity') throw new Error('Wrong parsed payload');
  const entry = parsed.entries[0];
  assert.ok(entry);
  assert.deepEqual(entry.images, images);
  assert.equal(entry.text, text);
});
