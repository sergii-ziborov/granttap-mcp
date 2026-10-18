import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Payload } from '../../../../../../packages/protocol/schema';
import { registerPendingApproval } from '../../../approvals/state';
import { handleMonitorMessage } from '../../handlers/inbound';

test('opening a notification refreshes pending Cursor questions before slow task discovery', async t => {
  const root = await mkdtemp(join(tmpdir(), 'granttap-attention-refresh-'));
  const prior = process.env.GRANTTAP_CONFIG_DIR; process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(async () => { if (prior === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = prior; await rm(root, { recursive: true, force: true }); });
  registerPendingApproval({ type: 'approval.request', requestId: 'cursor-notification-fixture',
    sessionId: 'cursor-task', agent: 'cursor', kind: 'permission', tool: 'Shell', title: 'Synthetic approval',
    risk: 'low', createdAt: Date.now() });
  const sent: Array<{ payload: Payload; peer?: string }> = [];
  const client = { room: 'fixture-room', send: async (payload: Payload, _to: unknown,
    options?: { peerPublicKey?: string }) => { sent.push({ payload, peer: options?.peerPublicKey }); } };
  let publishing = false;
  await handleMonitorMessage(client as never, { type: 'sessions.refresh', createdAt: Date.now() }, {
    leadership: { acquire: () => true }, subscriptions: new Set(), peerPublicKey: 'requesting-phone',
    publish: () => { publishing = true; return new Promise<void>(() => {}); },
  });
  const status = sent.find(row => row.payload.type === 'approvals.status');
  assert.ok(status && status.payload.type === 'approvals.status'
    && status.payload.pending.some(row => row.requestId === 'cursor-notification-fixture'));
  assert.equal(status.peer, 'requesting-phone');
  assert.equal(publishing, true, 'task discovery still proceeds independently');
});
