import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { localTaskTransfers } from '../../../../task-transfer';
import { rememberPublishedCatalog } from '../../../../session-catalog';
import { deliveryReceiptStatus } from '../../../../delivery';
import { handleInboundUserMessage } from '../..';

test('a transferred Grok turn publishes correlated start and native identity before its response', async t => {
  const root = await mkdtemp(join(tmpdir(), 'granttap-live-first-turn-'));
  const workspace = join(root, 'worktree'), release = join(root, 'release'), bin = join(root, 'grok.cjs');
  await mkdir(workspace);
  await writeFile(bin, `#!${process.execPath}
const fs = require('node:fs');
const id = process.argv[process.argv.indexOf('--session-id') + 1];
console.log(JSON.stringify({type:'thought',data:'Synthetic observed activity'}));
const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(release)})) return;
clearInterval(timer); console.log(JSON.stringify({type:'result',result:'Synthetic final answer',sessionId:id})); }, 20);
`, { mode: 0o755 });
  const prior = { config: process.env.GRANTTAP_CONFIG_DIR, bin: process.env.GRANTTAP_GROK_BIN };
  process.env.GRANTTAP_CONFIG_DIR = join(root, 'config'); process.env.GRANTTAP_GROK_BIN = bin;
  const transfers = localTaskTransfers();
  const row = transfers.prepare({ eventId: 'live-first-turn', projectId: 'fixture-project', title: 'Synthetic task',
    sourceSessionId: 'source', workspace, branch: 'fixture', context: 'Synthetic visible context', acceptedAt: 1,
    capsule: { taskId: 'fixture-task', goal: 'Synthetic goal', currentStatus: 'Ready', sourceProvider: 'codex',
      sourceComputer: 'source', targetProvider: 'grok', targetComputer: 'target', repository: 'fixture-repo',
      baseSha: 'a'.repeat(40), workingTree: 'clean', filesChanged: [], dependencies: [], resourceClaims: [],
      remainingWork: [], importantDecisions: [], createdAt: 1 } });
  t.after(async () => {
    await writeFile(release, 'finish');
    for (let n = 0; n < 100 && transfers.forEvent('live-first-turn')?.phase === 'starting'; n++) await setTimeout(20);
    for (const [key, value] of [['GRANTTAP_CONFIG_DIR', prior.config], ['GRANTTAP_GROK_BIN', prior.bin]]) {
      if (value == null) delete process.env[key!]; else process.env[key!] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const sent: Array<{ payload: any; peer?: string }> = [];
  const client = { room: 'fixture-room', isConnected: true, setSessionKey: () => {},
    send: async (payload: any, _to?: unknown, options?: { peerPublicKey?: string }) => {
      sent.push({ payload, peer: options?.peerPublicKey });
    }, sendSession: async () => {} };
  rememberPublishedCatalog(client as never, { type: 'sessions.status', machine: 'Fixture', generatedAt: Date.now(),
    sessions: transfers.catalog([]) });
  const messageId = 'original-first-turn';
  assert.equal(await handleInboundUserMessage(client as never, { type: 'user.message', messageId,
    sessionId: row.sessionId, text: 'Synthetic continuation', createdAt: Date.now() }, async () => {}, 'phone'), true);
  const receipt = sent.find(item => item.payload.type === 'delivery.receipt' && item.payload.agentActivityAt);
  assert.ok(receipt, 'Observed provider activity must reach the controller before the final answer');
  assert.equal(receipt.payload.messageId, messageId); assert.equal(receipt.payload.sessionId, row.sessionId);
  assert.equal(receipt.peer, 'phone'); assert.equal(receipt.payload.status, 'accepted');
  assert.equal(transfers.forEvent('live-first-turn')?.phase, 'starting', 'The provider has not finished its turn');
  assert.ok(transfers.forEvent('live-first-turn')?.nativeSessionId, 'Live native history must already be addressable');
  assert.equal(deliveryReceiptStatus(messageId, { room: client.room, peerPublicKey: 'phone',
    sessionId: row.sessionId })?.agentActivityAt, receipt.payload.agentActivityAt);
  assert.equal(sent.some(item => item.payload.type === 'agent.event' && item.payload.kind === 'response'), false);
});
