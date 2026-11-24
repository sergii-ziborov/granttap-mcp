import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClaudeSession, deliverToSession, hasPendingDeliveries, isDeliveryInFlight } from '../index';
import { runtimeWorkTracker } from '../../runtime-updates/readiness';

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
  const monitorWork = runtimeWorkTracker(hasPendingDeliveries);
  await monitorWork.run(async () => 'acknowledged');
  assert.equal(monitorWork.idle(), false, 'a delivery acknowledgement cannot hand off a running provider');
  assert.equal((await pending).ok, true);
  assert.equal(isDeliveryInFlight('synthetic-chat'), false);
  assert.equal(monitorWork.idle(), true);
});

test('a message to a new chat waits for its first run, also through a long silent command', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-first-run-'));
  const previous = { bin: process.env.GRANTTAP_CLAUDE_BIN, config: process.env.GRANTTAP_CONFIG_DIR };
  const bin = join(root, 'fixture-claude'), log = join(root, 'runs.log');
  // The first run is a long command that writes nothing; a resumed one answers at once.
  writeFileSync(bin, `#!/usr/bin/env node
const fs=require('node:fs'), args=process.argv.slice(2), first=args.includes('--session-id');
const id=args[args.indexOf(first?'--session-id':'--resume')+1];
fs.appendFileSync(${JSON.stringify(log)}, (first?'first':'resume')+' start\\n');
setTimeout(()=>{fs.appendFileSync(${JSON.stringify(log)}, (first?'first':'resume')+' end\\n');
process.stdout.write(JSON.stringify({result:'Synthetic answer',session_id:id}));}, first?600:20);
`, { mode: 0o755 });
  process.env.GRANTTAP_CLAUDE_BIN = bin; process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => {
    if (previous.bin === undefined) delete process.env.GRANTTAP_CLAUDE_BIN; else process.env.GRANTTAP_CLAUDE_BIN = previous.bin;
    if (previous.config === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = previous.config;
    rmSync(root, { recursive: true, force: true });
  });
  let chat: string | undefined;
  const first = createClaudeSession('Synthetic new task', root, 10_000, [], undefined, 'synthetic-op', undefined,
    id => { chat = id; });
  while (!chat) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(isDeliveryInFlight(chat), true, 'the new chat reads as busy while its first run lasts');
  const followUp = deliverToSession({ sessionId: chat, agent: 'claude', cwd: root, state: 'idle',
    startedAt: 1, lastActivityAt: 2, tokensSession: 0, tokensLastTurn: 0 }, 'Synthetic follow-up', 10_000);
  assert.equal((await first).ok, true);
  assert.equal((await followUp).ok, true);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['first start', 'first end', 'resume start', 'resume end'],
    'never a second process on the same conversation while the first still runs');
  assert.equal(isDeliveryInFlight(chat), false);
});
