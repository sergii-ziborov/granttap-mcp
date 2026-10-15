import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { captureTransferContext, PreparedTaskTransfers } from '../index';
import type { SessionActivity, SessionInfo, TaskCapsule } from '../../../../../packages/protocol/schema';
const session: SessionInfo = { sessionId: 'fixture', agent: 'codex', title: 'Original', state: 'idle',
  startedAt: 1, lastActivityAt: 3, tokensSession: 0, tokensLastTurn: 0 };
const capsule: TaskCapsule = { taskId: 'task', goal: 'Synthetic task', currentStatus: 'Ready',
  sourceProvider: 'codex', sourceComputer: 'source', targetProvider: 'grok', targetComputer: 'target',
  repository: 'repo', baseSha: 'a'.repeat(40), filesChanged: [], dependencies: [],
  resourceClaims: [], remainingWork: [], importantDecisions: [], createdAt: 1 };
const image = { id: 'image-fixture', name: 'photo.png', markdown: '![Image](granttap-image:image-fixture)' };
const page = (entries: SessionActivity['entries'], more = false): SessionActivity => ({
  type: 'session.activity', sessionId: 'fixture', agent: 'codex', state: 'idle', entries,
  generatedAt: 3, history: { hasMore: more, ...(more ? { cursor: 'older' } : {}) } });

test('transfer context carries every visible page and image, and materializes readable context outside the checkout', async () => {
  const first = page([{ id: 'reply', kind: 'final', text: 'Visible answer', createdAt: 3 }], true);
  const older = page([{ id: 'request', kind: 'user', text: 'Original request', createdAt: 1,
    images: [image], attachments: ['photo.png'] }]);
  const captured = await captureTransferContext(session, capsule, {
    page: (_, cursor) => cursor ? older : first,
    image: (_, id, offset) => id === image.id && offset === 0
      ? { data_base64: 'AQID', mime_type: 'image/png', offset: 0, total_bytes: 3 } : undefined,
  });
  const archive = JSON.parse(captured.context);
  assert.deepEqual(archive.entries.map((entry: any) => entry.text), ['Original request', 'Visible answer']);
  assert.equal(archive.entries[0].images[0].data, 'AQID');
  const root = mkdtempSync(join(tmpdir(), 'granttap-context-'));
  try {
    const transfers = new PreparedTaskTransfers(root);
    const row = transfers.prepare({ eventId: 'fixture-transfer', projectId: 'project', sourceSessionId: 'fixture',
      title: 'Original', capsule, context: captured.context, workspace: '/fixture/worktree', branch: 'granttap/fixture', acceptedAt: 1 });
    const readable = readFileSync(transfers.providerContextPath(row.sessionId), 'utf8');
    assert.ok(readable.includes('Original request')); assert.ok(readable.includes('Visible answer'));
    const file = join(root, `${row.sessionId}.images`, '0.png');
    assert.deepEqual(readFileSync(file), Buffer.from([1, 2, 3]));
    assert.ok(readable.includes(file)); assert.ok(!readable.includes('AQID'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an unrecoverable attachment or non-progressing cursor refuses the entire transfer', async () => {
  await assert.rejects(captureTransferContext(session, capsule, { page: () => page([
    { id: 'request', kind: 'user', text: 'Two attachments', createdAt: 1,
      images: [image], attachments: ['photo.png', 'missing.pdf'] }]),
    image: () => ({ data_base64: 'AQID', mime_type: 'image/png', offset: 0, total_bytes: 3 }),
  }), /attachment/i);
  await assert.rejects(captureTransferContext(session, capsule, { page: () => page([], true) }), /cursor/i);
  await assert.rejects(captureTransferContext(session, capsule, { page: () => undefined }), /partial/i);
});

test('a running turn or a conversation changing during capture cannot be transferred as complete', async () => {
  await assert.rejects(captureTransferContext({ ...session, state: 'working' }, capsule,
    { page: () => page([{ id: 'a', kind: 'user', text: 'Synthetic', createdAt: 1 }]) }), /pause|finish/i);
  let reads = 0;
  await assert.rejects(captureTransferContext(session, capsule, { page: () => page([
    { id: 'a', kind: 'message', text: ++reads === 1 ? 'Original snapshot' : 'New streamed content', createdAt: 1 },
  ]) }), /changed|complete/i);
});
