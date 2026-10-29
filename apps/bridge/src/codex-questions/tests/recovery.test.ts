import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Payload, type SessionInfo } from '../../../../../packages/protocol/schema';
import type { RelayClient } from '../../../../../packages/core/relay-client';
import { codexLogPathBySession } from '../../sessions/scan/codex/shared';
import { publishCodexQuestions } from '../index';
import { handleMonitorMessage } from '../../monitor/handlers/inbound';

test('opening a notification recovers its exact question before a catalog exists, without a full scan', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-question-recovery-'));
  const before = { ...process.env };
  Object.assign(process.env, { GRANTTAP_CONFIG_DIR: join(root, 'config'), GRANTTAP_CODEX_SESSIONS_DIR: join(root, 'codex', 'sessions') });
  const session: SessionInfo = { sessionId: '12345678-1234-1234-1234-123456789abc', agent: 'codex', state: 'idle',
    startedAt: Date.now(), lastActivityAt: Date.now(), tokensSession: 0, tokensLastTurn: 0 };
  const folder = join(root, 'codex', 'sessions'); mkdirSync(folder, { recursive: true });
  const path = join(folder, 'rollout-2026-10-29-' + session.sessionId + '.jsonl');
  writeFileSync(path, JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item',
    payload: { type: 'function_call', name: 'request_user_input_async', call_id: 'notification-call',
      arguments: JSON.stringify({ questions: [{ title: 'Synthetic pending request?', options: ['Yes', 'No'] }] }) } }) + '\n');
  codexLogPathBySession.set(session.sessionId, path);
  t.after(() => {
    codexLogPathBySession.delete(session.sessionId);
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before); rmSync(root, { recursive: true, force: true });
  });
  const sent: Array<{ payload: any; options: any }> = [];
  const client = { room: 'original-room', send: async (payload: unknown, _to: unknown, options: unknown) => {
    sent.push({ payload, options });
  } } as unknown as RelayClient;
  await publishCodexQuestions(client, [session]);
  const requestId = sent.find(row => row.payload.kind === 'question')!.payload.requestId;
  sent.length = 0;
  let scans = 0;
  const request = Payload.parse({ type: 'sessions.refresh', createdAt: Date.now(), notificationRequestId: requestId });
  const input = { leadership: { acquire: () => true }, subscriptions: new Set<string>(),
    peerPublicKey: 'opening-phone', publish: async () => { scans++; } };
  await handleMonitorMessage(client, request, input);
  const recovered = sent.filter(row => row.payload.kind === 'question');
  assert.equal(recovered.length, 1, 'The notification must not depend on a populated session catalog');
  assert.equal(recovered[0]!.payload.requestId, requestId);
  assert.equal(recovered[0]!.options.peerPublicKey, 'opening-phone');
  assert.equal(recovered[0]!.options.urgent, true, 'Recovery must overtake bulk transcript snapshots');
  assert.equal(scans, 0, 'Opening one notification must not schedule a full provider scan');
  sent.length = 0;
  codexLogPathBySession.delete(session.sessionId);
  await handleMonitorMessage(client, request, input);
  assert.equal(sent.filter(row => row.payload.kind === 'question').length, 1,
    'A monitor restart must restore the owned source without a catalog scan');
  sent.length = 0;
  await handleMonitorMessage({ ...client, room: 'foreign-room' } as RelayClient, request, input);
  assert.equal(sent.filter(row => row.payload.kind === 'question').length, 0, 'Another room cannot recover this request');
});
