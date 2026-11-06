import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskActivitySnapshot } from '../presentation';
import { activitySubscription } from '../subscription';
import { generateKeyPair, seal, generateTransferKey } from '../../../../../packages/core/crypto';
import type { PeerConfig } from '../../../../../packages/core/relay-client';
import type { SessionsStatus, SessionInfo } from '../../../../../packages/protocol/schema';

const session = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({ sessionId: id,
  agent: 'codex', state: 'working', startedAt: 1, lastActivityAt: 100, tokensSession: 0,
  tokensLastTurn: 0, title: 'Sample task', summary: 'Latest response', ...extra });
const catalog = (sessions: SessionInfo[]): SessionsStatus => ({ type: 'sessions.status',
  machine: 'QA Mac', sessions, generatedAt: 1_000_000 });

test('one card per stable task, bounded UTF-8 previews, deterministic recent ordering', () => {
  const snapshot = taskActivitySnapshot(catalog([session('a', {projectId: 'p', taskId: 't'}),
    session('b', {projectId: 'p', taskId: 't', lastActivityAt: 200}),
    session('c', {title: 'я'.repeat(500), summary: '🙂'.repeat(500), lastActivityAt: 300}),
    session('d')]), {keyId: 'opaque', previews: true});
  assert.equal(snapshot.taskCount, 3);
  assert.equal(snapshot.rows.length, 2);
  assert.equal(snapshot.rows[0]!.lastActivityAt, 300);
  assert.ok(Buffer.byteLength(snapshot.rows[0]!.title) <= 128);
  assert.ok(!snapshot.rows[0]!.preview.includes('\uFFFD'));
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 2048);
  assert.equal(snapshot.generatedAt, 1_000_000);
});

test('privacy mode omits computer and task text, empty catalog remains empty', () => {
  const snapshot = taskActivitySnapshot(catalog([session('a')]), {keyId: 'opaque', previews: false});
  assert.equal(snapshot.machine, 'GrantTap');
  assert.equal(snapshot.taskCount, 1);
  assert.deepEqual(snapshot.rows, []);
  assert.equal(taskActivitySnapshot(catalog([]), {keyId: 'opaque', previews: true}).taskCount, 0);
});

test('enrollment requires a known allowed phone, exact activity scope and unexpired preview key', () => {
  const machine = generateKeyPair(), phone = generateKeyPair(), stranger = generateKeyPair();
  const config: PeerConfig = {role: 'machine', room: 'qa-room', relayUrl: 'wss://example.com',
    deviceName: 'QA', senderId: 'qa', myPublicKey: machine.publicKey, mySecretKey: machine.secretKey,
    peerPublicKey: phone.publicKey};
  const body = {version: 1, kind: 'task.activity.subscription', room: config.room, activityId: 'activity',
    keyId: 'opaque', key: generateTransferKey(), expiresAt: 1_100_000, previews: true};
  const record = {activityId: body.activityId, expiresAt: body.expiresAt,
    ...seal(body, machine.publicKey, phone.secretKey)};
  assert.equal(activitySubscription(config, record, () => true, 1_000_000)?.keyId, 'opaque');
  assert.equal(activitySubscription(config, record, () => false, 1_000_000), null);
  assert.equal(activitySubscription(config, record, () => true, 1_200_000), null);
  assert.equal(activitySubscription(config, {...record, activityId: 'other'}, () => true, 1_000_000), null);
  assert.equal(activitySubscription(config, {...record, ...seal(body, machine.publicKey, stranger.secretKey)},
    () => true, 1_000_000), null);
});
