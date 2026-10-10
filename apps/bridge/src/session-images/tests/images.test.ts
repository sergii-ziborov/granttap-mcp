import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTranscriptHistory } from '../../transcript-history';
import { codexLogPathBySession } from '../../sessions/scan/codex/shared';
import { claudeLogPathBySession } from '../../sessions/scan/claude/shared';
import { readSessionImage, activityWithImages } from '..';
import { sessionImageChunk, desktopTaskImage } from '../../../../mcp/src/desktop/image';
import { Payload } from '../../../../../packages/protocol/schema';
import type { SessionInfo, SessionImageQuery, SessionActivity } from '../../../../../packages/protocol/schema';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
function query(session: SessionInfo, imageId: string, offset = 0): SessionImageQuery {
  return { type: 'session.image.query', sessionId: session.sessionId, requestId: 'request', imageId, offset, createdAt: 1 };
}

for (const provider of ['codex', 'claude'] as const) {
  test(`${provider}: a native picture is recovered from its exact paged conversation`, t => {
    const root = mkdtempSync(join(tmpdir(), 'granttap-native-picture-'));
    const id = `native-picture-${provider}`, path = join(root, 'log.jsonl');
    t.after(() => { rmSync(root, { recursive: true, force: true });
      codexLogPathBySession.delete(id); claudeLogPathBySession.delete(id); });
    const blocks = provider === 'codex' ? [{ type: 'input_image', image_url: `data:image/png;base64,${png.toString('base64')}` }]
      : [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }];
    const row = provider === 'codex'
      ? { type: 'response_item', timestamp: new Date(1000).toISOString(), payload: { type: 'message', role: 'user', content: blocks } }
      : { type: 'user', uuid: 'photo-user', timestamp: new Date(1000).toISOString(), message: { role: 'user', content: blocks } };
    writeFileSync(path, JSON.stringify(row) + '\n');
    (provider === 'codex' ? codexLogPathBySession : claudeLogPathBySession).set(id, path);
    const session: SessionInfo = { sessionId: id, agent: provider, state: 'idle', startedAt: 1,
      lastActivityAt: 1000, tokensSession: 0, tokensLastTurn: 0 };
    const activity = readTranscriptHistory(session)!;
    const imageId = activity.entries.find(e => e.attachments?.includes('Image'))!.id;
    const store = join(root, 'mesh.json');
    writeFileSync(store, JSON.stringify({ version: 1,
      projects: [{ projectId: 'project', name: 'Test', canonicalRepositoryId: 'repo', createdAt: 1 }],
      tasks: [{ taskId: 'task', projectId: 'project', title: 'Picture', goal: 'Test', state: 'working', createdAt: 1, updatedAt: 2 }],
      executions: [{ taskId: 'task', sessionId: id, provider, computerId: 'computer', workspace: root, startedAt: 1 }] }));
    const local = desktopTaskImage({ project_id: 'project', task_id: 'task', image_id: imageId, offset: 0 }, store);
    assert.ok(local, 'The Mac local reader must recover the same native picture');
    assert.deepEqual(Buffer.from(local.data_base64, 'base64'), png);
    const chunk = readSessionImage(query(session, imageId), session, activity)!;
    assert.deepEqual(Buffer.from(chunk.data_base64, 'base64'), png);
    assert.equal(chunk.total_bytes, png.length);
    assert.equal(readSessionImage(query(session, imageId), { ...session, sessionId: 'foreign' }, activity), undefined);
    assert.equal(readSessionImage(query(session, 'guessed-image'), session, activity), undefined);
    assert.equal(readSessionImage(query(session, imageId, -1), session, activity), undefined);
    assert.equal(readSessionImage(query(session, imageId, png.length), session, activity), undefined);
  });
}

test('workspace pictures retain execution and workspace access checks', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-picture-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'work'); mkdirSync(workspace);
  const picture = join(workspace, 'result.png'); writeFileSync(picture, png);
  const store = join(root, 'mesh.json');
  writeFileSync(store, JSON.stringify({ version: 1,
    projects: [{ projectId: 'project', name: 'Test', canonicalRepositoryId: 'repo', createdAt: 1 }],
    tasks: [{ taskId: 'task', projectId: 'project', title: 'Images', goal: 'Test', state: 'working', createdAt: 1, updatedAt: 2 }],
    executions: [{ taskId: 'task', sessionId: 'chat', provider: 'codex', computerId: 'computer', workspace, startedAt: 1 }] }));
  const session: SessionInfo = { sessionId: 'chat', agent: 'codex', state: 'idle', startedAt: 1,
    lastActivityAt: 1, tokensSession: 0, tokensLastTurn: 0 };
  const original: SessionActivity = { type: 'session.activity', sessionId: 'chat', agent: 'codex',
    state: 'idle', generatedAt: 1, entries: [{ id: 'reply', kind: 'final', createdAt: 1,
      text: `![result](<${picture}>)` }] };
  const activity = activityWithImages(original), id = activity.entries[0]!.images![0]!.id;
  assert.equal(activityWithImages({ ...original, entries: [] }).entries.length, 0);
  const chunk = sessionImageChunk(session, activity, id, 0, undefined, store)!;
  assert.deepEqual(Buffer.from(chunk.data_base64, 'base64'), png);
  assert.equal(sessionImageChunk({ ...session, agent: 'claude' }, activity, id, 0, undefined, store), undefined);
  assert.equal(sessionImageChunk(session, activity, id, 0, undefined, join(root, 'missing')), undefined);
  assert.equal(sessionImageChunk(session, { ...activity, sessionId: 'other' }, id, 0, undefined, store), undefined);
});

test('invalid, oversized and contradictory chunks fail wire validation', () => {
  const valid = { type: 'session.image.chunk', sessionId: 'chat', requestId: 'request', imageId: 'photo',
    offset: 0, totalBytes: 3, mimeType: 'image/png', dataBase64: 'YWJj' };
  for (const patch of [{ offset: -1 }, { totalBytes: 2 }, { totalBytes: 8 * 1024 * 1024 + 1 },
    { mimeType: 'text/plain' }, { dataBase64: '@@@@' }, { dataBase64: '' }, { unavailable: true }]) {
    assert.equal(Payload.safeParse({ ...valid, ...patch }).success, false);
  }
  assert.equal(Payload.safeParse({ type: valid.type, sessionId: 'chat', requestId: 'request',
    imageId: 'photo', offset: 0, unavailable: true }).success, true);
});
