import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { beginDelivery, completeDelivery, rejectCompletedDelivery, acknowledgeProcessingDelivery } from '../../../delivery';
import { handleMonitorMessage } from '../../handlers/inbound';

test('status refresh recovers original receipts across restart without another provider turn', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-status-'));
  const prior = process.env.GRANTTAP_CONFIG_DIR; process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => { if (prior == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = prior; rmSync(root, { recursive: true, force: true }); });
  const scope = { room: 'room', peerPublicKey: 'origin', sessionId: 'grok-chat' }, now = Date.now();
  beginDelivery('failed-message', now, scope); completeDelivery('failed-message', now);
  rejectCompletedDelivery('failed-message', 'Grok did not accept the message', now);
  beginDelivery('processing-message', now, scope); acknowledgeProcessingDelivery('processing-message', now);
  beginDelivery('unvalidated-message', now, scope);
  assert.equal(beginDelivery('failed-message', now, { ...scope, peerPublicKey: 'other' }), 'foreign');
  const sent: any[] = [];
  const client = { room: 'room', send: async (payload: unknown, _to: unknown, options: unknown) =>
    { sent.push({ payload, options }); } };
  const query = async (messageId: string, peerPublicKey = 'origin', sessionId = 'grok-chat') => {
    sent.length = 0;
    await handleMonitorMessage(client as never, { type: 'delivery.receipt.query', messageId, sessionId,
      createdAt: Date.now() } as never, { leadership: { acquire: () => true }, subscriptions: new Set(),
      publish: async () => { throw new Error('No discovery or provider work is needed for a receipt.'); }, peerPublicKey });
    return sent;
  };
  await query('failed-message');
  assert.equal(sent[0]?.payload.status, 'rejected');
  assert.equal(sent[0]?.payload.error, 'Grok did not accept the message');
  assert.equal(sent[0]?.options.peerPublicKey, 'origin');
  await query('processing-message'); assert.equal(sent[0]?.payload.status, 'accepted');
  for (const args of [['failed-message', 'other'], ['failed-message', 'origin', 'other-chat'],
    ['missing'], ['unvalidated-message']]) { await query(...args as [string, string?, string?]); assert.equal(sent.length, 0); }
  client.room = 'other-room'; await query('failed-message'); assert.equal(sent.length, 0);
});

test('confirmed provider activity survives receipt replay without becoming a response', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-started-status-'));
  const prior = process.env.GRANTTAP_CONFIG_DIR; process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => { if (prior == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = prior; rmSync(root, { recursive: true, force: true }); });
  const scope = { room: 'room', peerPublicKey: 'origin', sessionId: 'grok-chat' }, now = Date.now();
  beginDelivery('active-message', now - 10, scope); acknowledgeProcessingDelivery('active-message', now - 5);
  completeDelivery('active-message', now - 2);
  const delivery = await import('../../../delivery');
  delivery.acknowledgeAgentActivity('active-message', now - 1);
  const sent: any[] = [];
  const client = { room: 'room', send: async (payload: unknown) => { sent.push(payload); } };
  await handleMonitorMessage(client as never, { type: 'delivery.receipt.query', messageId: 'active-message',
    sessionId: scope.sessionId, createdAt: now } as never,
  { leadership: { acquire: () => true }, subscriptions: new Set(), publish: async () => {}, peerPublicKey: 'origin' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].status, 'accepted');
  assert.equal(sent[0].agentActivityAt, now - 1);
  rejectCompletedDelivery('active-message', 'Provider stopped', now);
  assert.equal(delivery.deliveryReceiptStatus('active-message', scope)?.status, 'rejected');
});
