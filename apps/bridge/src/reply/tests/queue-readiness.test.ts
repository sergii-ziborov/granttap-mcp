import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deliverToSession, isDeliveryInFlight } from '../index';

test('native submission readiness covers an owned turn and clears when it actually finishes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-delivery-ready-'));
  const previous = { bin: process.env.GRANTTAP_GROK_BIN, config: process.env.GRANTTAP_CONFIG_DIR };
  const bin = join(root, 'fixture-provider');
  writeFileSync(bin, `#!/usr/bin/env node
setTimeout(()=>{process.stdout.write(JSON.stringify({type:'text',data:'Synthetic work complete'})+'\\n');
process.stdout.write(JSON.stringify({type:'end',sessionId:'synthetic-chat'})+'\\n');},100);
`, { mode: 0o755 });
  process.env.GRANTTAP_GROK_BIN = bin; process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => {
    if (previous.bin === undefined) delete process.env.GRANTTAP_GROK_BIN; else process.env.GRANTTAP_GROK_BIN = previous.bin;
    if (previous.config === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = previous.config;
    rmSync(root, { recursive: true, force: true });
  });
  const pending = deliverToSession({ sessionId: 'synthetic-chat', agent: 'grok', cwd: root, state: 'idle',
    startedAt: 1, lastActivityAt: 2, tokensSession: 0, tokensLastTurn: 0 }, 'Synthetic follow-up', 5_000);
  assert.equal(isDeliveryInFlight('synthetic-chat'), true);
  assert.equal((await pending).ok, true);
  assert.equal(isDeliveryInFlight('synthetic-chat'), false);
});
