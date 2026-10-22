import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Payload, SessionInfo } from '../../../../../../packages/protocol/schema';
import { saveRuntimeConfig } from '../../../config';
import { completedDeliveryFailure, hasAcceptedDelivery } from '../../../delivery';
import { rememberPublishedCatalog } from '../../../session-catalog';
import { handleInboundUserMessage } from '..';

class Relay {
  room = 'late-provider-outcome';
  isConnected = true;
  sent: Payload[] = [];
  setSessionKey() {}
  async send(payload: Payload) { this.sent.push(payload); }
  async sendSession(payload: Payload) { this.sent.push(payload); }
}

for (const existing of [false, true]) {
 for (const delay of [200, 3300]) {
  test(`a provider failure after ${delay}ms preserves ${existing ? 'existing' : 'new'} task delivery receipt`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'granttap-late-run-'));
    const previous = { config: process.env.GRANTTAP_CONFIG_DIR, bin: process.env.GRANTTAP_GROK_BIN };
    process.env.GRANTTAP_CONFIG_DIR = join(root, 'config');
    process.env.GRANTTAP_GROK_BIN = join(root, 'grok-fixture');
    t.after(async () => {
      for (const [key, value] of Object.entries({ GRANTTAP_CONFIG_DIR: previous.config,
        GRANTTAP_GROK_BIN: previous.bin })) {
        if (value == null) delete process.env[key]; else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    });
    await writeFile(process.env.GRANTTAP_GROK_BIN, '#!/usr/bin/env node\n'
      + 'process.stdout.write(JSON.stringify({type:"text",data:"Started synthetic run"})+"\\n");\n'
      + `setTimeout(() => { process.stderr.write("Fixture run stopped"); process.exit(1); }, ${delay});\n`,
    { mode: 0o755 });
    saveRuntimeConfig({ providerSettings: { claude: false, codex: false, cursor: false, grok: true } });
    const relay = new Relay();
    const session: SessionInfo = { agent: 'grok', sessionId: 'existing-fixture', cwd: root,
      state: 'idle', startedAt: Date.now(), lastActivityAt: Date.now(),
      tokensSession: 0, tokensLastTurn: 0 };
    if (existing) rememberPublishedCatalog(relay as never, { type: 'sessions.status', machine: 'Fixture',
      sessions: [session], generatedAt: Date.now() });
    const messageId = existing ? 'existing-late' : 'new-late';
    assert.equal(await handleInboundUserMessage(relay as never, { type: 'user.message', messageId,
      agent: 'grok', sessionId: existing ? session.sessionId : undefined,
      text: 'Synthetic delivery check', createdAt: Date.now() }, async () => {}), true);
    assert.equal(hasAcceptedDelivery(messageId), true);
    const deadline = Date.now() + 3_000;
    while (!relay.sent.some(p => p.type === 'agent.event' && p.text.includes('stopped'))
      && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(relay.sent.some(p => p.type === 'agent.event' && p.text.includes('stopped')),
      'the execution failure must still reach the person');
    assert.equal(completedDeliveryFailure(messageId), undefined,
      'a run failure cannot rewrite the durable accepted delivery');
    assert.equal(relay.sent.some(p => p.type === 'delivery.receipt' && p.status === 'rejected'), false,
      'retrying an already accepted prompt can duplicate a real turn');
    assert.equal(hasAcceptedDelivery(messageId), true);
    const before = relay.sent.length;
    await handleInboundUserMessage(relay as never, { type: 'user.message', messageId,
      agent: 'grok', text: 'Synthetic delivery check', createdAt: Date.now() }, async () => {});
    assert.deepEqual(relay.sent.slice(before).map(p => p.type === 'delivery.receipt' ? p.status : p.type),
      ['accepted'], 'a replay acknowledges the original receipt without launching again');
  });
 }
}
