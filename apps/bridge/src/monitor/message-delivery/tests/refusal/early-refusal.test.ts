import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { Payload } from '../../../../../../../packages/protocol/schema';
import { saveRuntimeConfig } from '../../../../config';
import { deliveryReceiptStatus } from '../../../../delivery';
import { rememberPublishedCatalog } from '../../../../session-catalog';
import { handleInboundUserMessage } from '../..';
import { handleDeliveryReceiptQuery } from '../../status-query';

function fixture(t: TestContext, disabled = true) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-refusal-'));
  const prior = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = join(root, 'config');
  t.after(() => { if (prior == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = prior; rmSync(root, { recursive: true, force: true }); });
  saveRuntimeConfig({ providerSettings: { claude: false, codex: false, cursor: false, grok: !disabled } });
  const sent: Array<{ payload: Payload; peer?: string }> = [];
  const relay = { room: 'refusal-room', isConnected: true, setSessionKey() {},
    async send(payload: Payload, _to?: unknown, options?: { peerPublicKey?: string }) {
      sent.push({ payload, peer: options?.peerPublicKey });
    },
    async sendSession(payload: Payload, _session?: string, _to?: unknown, options?: { peerPublicKey?: string }) {
      sent.push({ payload, peer: options?.peerPublicKey });
    } };
  const scope = { room: relay.room, peerPublicKey: 'requesting-phone', sessionId: 'synthetic-session' };
  rememberPublishedCatalog(relay as never, { type: 'sessions.status', machine: 'Synthetic', generatedAt: Date.now(),
    sessions: [{ sessionId: scope.sessionId, agent: 'grok', cwd: root, state: 'idle', startedAt: 1,
      lastActivityAt: 1, tokensSession: 0, tokensLastTurn: 0 }] });
  const message = { type: 'user.message' as const, messageId: 'original-early-refusal',
    sessionId: scope.sessionId, text: 'Synthetic admission test', createdAt: Date.now() };
  return { relay, scope, sent, message };
}

test('a disabled-provider refusal emits and durably retains its original scoped receipt', async t => {
  const { relay, scope, sent, message } = fixture(t);
  assert.equal(await handleInboundUserMessage(relay as never, message, async () => {}, scope.peerPublicKey), true);
  const refusal = sent.find(row => row.payload.type === 'delivery.receipt' && row.payload.status === 'rejected');
  assert.ok(refusal, 'consuming the submission must not leave Saved on relay without its refusal');
  assert.equal(refusal.peer, scope.peerPublicKey);
  assert.equal(refusal.payload.type === 'delivery.receipt' && refusal.payload.messageId, message.messageId);
  assert.equal(deliveryReceiptStatus(message.messageId, scope)?.status, 'rejected');
  assert.equal(deliveryReceiptStatus(message.messageId, { ...scope, peerPublicKey: 'other-phone' }), undefined);
  sent.length = 0;
  await handleInboundUserMessage(relay as never, message, async () => {}, scope.peerPublicKey);
  assert.equal(sent.filter(row => row.payload.type === 'agent.event').length, 0, 'a repeated box cannot run again');
  assert.equal(sent.filter(row => row.payload.type === 'delivery.receipt').length, 1);
});

test('a later read-only status query recovers a lost early refusal without another provider attempt', async t => {
  const { relay, scope, sent, message } = fixture(t);
  await handleInboundUserMessage(relay as never, message, async () => {}, scope.peerPublicKey);
  sent.length = 0;
  // A fresh client consumes the saved disk record, not the old event or an in-memory result.
  const fresh = { room: relay.room, send: relay.send };
  await handleDeliveryReceiptQuery(fresh as never, { type: 'delivery.receipt.query',
    messageId: message.messageId, sessionId: scope.sessionId, createdAt: Date.now() }, scope.peerPublicKey);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.payload.type === 'delivery.receipt' && sent[0].payload.status, 'rejected');
  assert.equal(sent[0]?.payload.type === 'delivery.receipt' && sent[0].payload.error,
    'This agent is disabled in GrantTap Settings.');
});

test('task capability refusal retains its specific cause and does not report provider execution', async t => {
  const { relay, scope, sent, message } = fixture(t, false);
  await handleInboundUserMessage(relay as never, { ...message, skill: 'absent-synthetic-skill' }, async () => {}, scope.peerPublicKey);
  const status = deliveryReceiptStatus(message.messageId, scope);
  assert.equal(status?.status, 'rejected');
  assert.equal(status?.error, "The selected project skill is no longer available in this task's folder.");
  assert.equal(sent.some(row => row.payload.type === 'delivery.receipt' && row.payload.status === 'accepted'), false);
});
