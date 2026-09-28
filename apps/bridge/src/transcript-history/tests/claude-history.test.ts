import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readTranscriptHistory } from '../index';
import { claudeActivity, claudeLogPathBySession } from '../../sessions/scan/claude';
import type { SessionInfo } from '../../../../../packages/protocol/schema';

test('Claude native pages preserve requests through a long turn and live refresh', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-claude-history-'));
  const path = join(root, 'session.jsonl');
  const session: SessionInfo = { sessionId: 'claude-history', agent: 'claude', state: 'idle',
    startedAt: 1, lastActivityAt: 100, tokensSession: 0, tokensLastTurn: 0 };
  t.after(() => { claudeLogPathBySession.delete(session.sessionId); rmSync(root, { recursive: true }); });
  const row = (i: number, type: string, text: string) => JSON.stringify({ uuid: `row-${i}`, type,
    timestamp: new Date(1000 + i).toISOString(), message: { role: type, content: text } });
  const lines = [row(0, 'user', 'Continue'), row(1, 'user', 'Continue'),
    ...Array.from({ length: 500 }, (_, i) => row(i + 2, 'assistant', `Reply ${i}`))];
  writeFileSync(path, lines.join('\n') + '\n');
  claudeLogPathBySession.set(session.sessionId, path);
  let page = readTranscriptHistory(session);
  assert.ok(page?.history?.hasMore);
  const entries = new Map<string, string>();
  for (let i = 0; page && i < 20; i++) {
    for (const entry of page.entries) { assert.ok(!entries.has(entry.id)); entries.set(entry.id, entry.text); }
    if (!page.history?.hasMore) break;
    const cursor = page.history.cursor;
    const repeated = readTranscriptHistory(session, cursor);
    page = readTranscriptHistory(session, cursor);
    assert.deepEqual(page?.entries, repeated?.entries);
  }
  assert.equal(entries.size, 502);
  assert.equal([...entries.values()].filter(text => text === 'Continue').length, 2);
  assert.equal(page?.history?.hasMore, false);
  appendFileSync(path, row(502, 'assistant', 'New reply') + '\n');
  const live = claudeActivity(session);
  const latest = readTranscriptHistory(session);
  for (const entry of latest?.entries ?? []) {
    if (entries.has(entry.id)) assert.equal(entries.get(entry.id), entry.text);
    assert.ok(live.some(item => item.id === entry.id));
  }
  assert.equal(readTranscriptHistory(session, 'invalid'), undefined);
  assert.equal(readTranscriptHistory({ ...session, agent: 'unknown' }), undefined);
});

test('an attachment-only Claude request survives native paging without copying image bytes', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-claude-attachment-'));
  const path = join(root, 'session.jsonl');
  const session: SessionInfo = { sessionId: 'claude-attachment', agent: 'claude', state: 'idle',
    startedAt: 1, lastActivityAt: 10, tokensSession: 0, tokensLastTurn: 0 };
  t.after(() => { claudeLogPathBySession.delete(session.sessionId); rmSync(root, { recursive: true }); });
  writeFileSync(path, JSON.stringify({ type: 'user', uuid: 'image-request', timestamp: new Date(2).toISOString(),
    message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'fixture-image' } }] } }) + '\n');
  claudeLogPathBySession.set(session.sessionId, path);
  const page = readTranscriptHistory(session);
  assert.equal(page?.entries.length, 1);
  assert.equal(page?.entries[0]?.kind, 'user');
  assert.deepEqual(page?.entries[0]?.attachments, ['Image']);
  assert.doesNotMatch(JSON.stringify(page), /fixture-image/);
  assert.deepEqual(claudeActivity(session), page?.entries);
});

test('identical Claude requests stamped in the same millisecond remain separate', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-claude-repeat-'));
  const path = join(root, 'session.jsonl');
  const session: SessionInfo = { sessionId: 'claude-repeat', agent: 'claude', state: 'idle',
    startedAt: 1, lastActivityAt: 10, tokensSession: 0, tokensLastTurn: 0 };
  t.after(() => { claudeLogPathBySession.delete(session.sessionId); rmSync(root, { recursive: true }); });
  writeFileSync(path, [0, 1].map(i => JSON.stringify({ type: 'user', uuid: `request-${i}`,
    timestamp: new Date(2).toISOString(), message: { role: 'user', content: 'Continue' } })).join('\n') + '\n');
  claudeLogPathBySession.set(session.sessionId, path);
  const page = readTranscriptHistory(session);
  assert.equal(page?.entries.length, 2);
  assert.equal(new Set(page?.entries.map(e => e.id)).size, 2);
  assert.deepEqual(claudeActivity(session), page?.entries);
});
