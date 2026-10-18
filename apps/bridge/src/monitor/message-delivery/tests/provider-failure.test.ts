import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import type { Payload } from '../../../../../../packages/protocol/schema';
import { rememberPublishedCatalog } from '../../../session-catalog';
import { handleInboundUserMessage } from '..';

test('a provider refusal after startup rejects the bubble and targets the requesting controller', async t => {
  const root = await mkdtemp(join(tmpdir(), 'granttap-provider-failure-'));
  const bin = join(root, 'cursor.mjs'), release = join(root, 'release');
  await writeFile(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(release)})) return;
clearInterval(timer); console.error('Synthetic provider startup refused'); process.exit(1); }, 10);
`, { mode: 0o755 });
  // CommonJS file so the provider fixture works without any package loader.
  const cjs = bin.replace('.mjs', '.cjs');
  const { rename } = await import('node:fs/promises'); await rename(bin, cjs);
  const prior = { bin: process.env.GRANTTAP_CURSOR_AGENT_BIN, root: process.env.GRANTTAP_CONFIG_DIR };
  Object.assign(process.env, { GRANTTAP_CURSOR_AGENT_BIN: cjs, GRANTTAP_CONFIG_DIR: join(root, 'config') });
  t.after(async () => {
    await writeFile(release, 'release');
    for (const [key, value] of [['GRANTTAP_CURSOR_AGENT_BIN', prior.bin], ['GRANTTAP_CONFIG_DIR', prior.root]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const sent: Array<{ payload: Payload; peer?: string }> = [];
  const client = { room: 'fixture-room', isConnected: true, setSessionKey: () => {},
    send: async (payload: Payload, _to?: unknown, options?: { peerPublicKey?: string }) => {
      sent.push({ payload, peer: options?.peerPublicKey });
    },
    sendSession: async (payload: Payload, _id: string, _to?: unknown, options?: { peerPublicKey?: string }) => {
      sent.push({ payload, peer: options?.peerPublicKey });
    } };
  const sessionId = 'cursor-fixture-failure';
  rememberPublishedCatalog(client as never, { type: 'sessions.status', machine: 'Fixture', generatedAt: Date.now(),
    sessions: [{ sessionId, agent: 'cursor', cwd: root, state: 'idle', startedAt: 1,
      lastActivityAt: 1, tokensSession: 0, tokensLastTurn: 0 }] });
  const handled = await handleInboundUserMessage(client as never, { type: 'user.message', sessionId,
    messageId: 'late-startup-failure', text: 'Synthetic continuation', createdAt: Date.now() },
  async () => {}, 'requesting-phone');
  assert.equal(handled, true);
  await writeFile(release, 'release');
  for (let n = 0; n < 100 && !sent.some(({ payload }) => payload.type === 'delivery.receipt'
    && payload.status === 'rejected'); n++) await setTimeout(20);
  const rejected = sent.find(({ payload }) => payload.type === 'delivery.receipt' && payload.status === 'rejected');
  assert.ok(rejected, 'the processing acknowledgement cannot hide a later provider refusal');
  assert.equal(rejected.peer, 'requesting-phone');
  assert.ok(sent.filter(({ payload }) => payload.type === 'agent.event' || payload.type === 'delivery.receipt')
    .every(row => row.peer === 'requesting-phone'), 'responses must not fill unrelated controller queues');
  sent.length = 0;
  await handleInboundUserMessage(client as never, { type: 'user.message', sessionId,
    messageId: 'late-startup-failure', text: 'Synthetic continuation', createdAt: Date.now() },
  async () => {}, 'requesting-phone');
  assert.ok(sent.some(({ payload }) => payload.type === 'delivery.receipt' && payload.status === 'rejected'),
    'a repeated box cannot turn a durable refusal back into accepted');
  assert.equal(sent.filter(({ payload }) => payload.type === 'agent.event').length, 0, 'never start a second run');
});
