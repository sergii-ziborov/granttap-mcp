import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createGrantTapServer } from '../../http/create-server';
import { connectInMemory, textResult } from '../../../../../tests/support/mcp-client';
import { createPairing, machineConfigPath, saveConfig } from '../../../../bridge/src/config';
import { writeLimitContinuationState } from '../../../../bridge/src/limit-continuation/store';
import { setRuntimeAutoUpdate } from '../../../../bridge/src/runtime-updates';
import { TaskDispatchInbox } from '../../../../bridge/src/task-dispatch';
import { generateKeyPair } from '../../../../../packages/core/crypto';
import type { TaskDispatch } from '../../../../../packages/protocol/schema';

const chat = 'status-details-chat';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-status-details-'));
  const keys = ['GRANTTAP_CONFIG_DIR', 'CLAUDE_CODE_SESSION_ID'] as const;
  const previous = keys.map(key => process.env[key]);
  process.env.GRANTTAP_CONFIG_DIR = root;
  process.env.CLAUDE_CODE_SESSION_ID = chat;
  t.after(() => {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    rmSync(root, { recursive: true, force: true });
  });
  const machine = createPairing('ws://127.0.0.1:1').machineCfg;
  saveConfig(machineConfigPath(), machine);
  return { root, room: machine.room };
}

function queue(root: string, room: string, sessions: string[]): void {
  const inbox = new TaskDispatchInbox(join(root, 'task-dispatch'), room), phone = generateKeyPair().publicKey;
  sessions.forEach((sessionId, index) => {
    const now = Date.now(), jobId = `status-details-${index + 1}`;
    const job: TaskDispatch = { type: 'task.dispatch', jobId, token: 'c'.repeat(64), sessionId, notBefore: now,
      expiresAt: now + 86_400_000, createdAt: now,
      operation: { type: 'user.message', sessionId, messageId: `${jobId}-message`, text: 'Synthetic follow-up', createdAt: now } };
    inbox.stage(job, phone);
  });
}

function stageRelease(root: string, version: string): string {
  const runtime = join(root, 'runtime-updates', 'versions', version, 'node_modules', 'granttap-mcp');
  mkdirSync(join(runtime, 'bin'), { recursive: true });
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: 'granttap-mcp', version }));
  writeFileSync(join(runtime, 'bin', 'granttap-mcp.mjs'), '');
  return runtime;
}

async function status() {
  const server = createGrantTapServer(), client = await connectInMemory(server);
  try {
    const result = await client.callTool({ name: 'connection_status', arguments: {} });
    return { structured: result.structuredContent as Record<string, unknown>, text: textResult(result) };
  } finally { await client.close(); await server.close(); }
}

test('status tells the calling chat how many phone messages wait for it and how it continues after a limit', async t => {
  const f = fixture(t), resetsAt = Date.now() + 3_600_000;
  queue(f.root, f.room, [chat, chat, 'another-chat']);
  writeLimitContinuationState({ off: [], scheduled: { [chat]: { resetsAt, messageId: 'limit-continue-fixture',
    scope: { sessionId: chat, provider: 'claude' }, scheduledAt: Date.now() } } });
  const before = readdirSync(f.root, { recursive: true }).sort();
  const first = await status();
  assert.deepEqual(first.structured.chat, { queuedPhoneMessages: 2, autoContinue: true,
    continuation: { dueAt: resetsAt + 60_000, early: false } });
  assert.match(first.text, /This chat: 2 phone messages are queued to reach it after this turn; a continuation after a subscription limit is queued for it, due /);
  assert.match(first.text, /Paired phones: 1 — 0 active in the last minute, 0 more seen in the last 7 days, 1 not seen for 7 days or never\./);
  assert.deepEqual(readdirSync(f.root, { recursive: true }).sort(), before, 'reading the status wrote nothing');
  writeLimitContinuationState({ off: [chat], scheduled: {} });
  const off = await status();
  assert.deepEqual(off.structured.chat, { queuedPhoneMessages: 2, autoContinue: false, continuation: null });
  assert.match(off.text, /it does not continue by itself after a subscription limit/);
  delete process.env.CLAUDE_CODE_SESSION_ID;
  const unbound = await status();
  assert.equal(unbound.structured.chat, null, 'without a chat in its environment the server guesses none');
  assert.doesNotMatch(unbound.text, /This chat:/);
});

test('status names a newer runtime that waits, and why', async t => {
  const f = fixture(t);
  assert.equal((await status()).structured.pendingUpdate, null);
  stageRelease(f.root, '0.0.1');
  assert.equal((await status()).structured.pendingUpdate, null, 'an older cached release is kept for rollback, not pending');
  const runtime = stageRelease(f.root, '999.0.0');
  const downloaded = await status();
  assert.deepEqual({ ...downloaded.structured.pendingUpdate as object, detail: undefined },
    { version: '999.0.0', state: 'downloaded', detail: undefined });
  assert.match(downloaded.text, /Runtime 999\.0\.0 is waiting: Downloaded\. It takes over once the monitor's running work has ended; new phone messages wait for that at most 10 min at a time/);
  setRuntimeAutoUpdate(false);
  assert.match((await status()).text, /Runtime 999\.0\.0 is waiting: Downloaded, but automatic updates are off/);
  writeFileSync(join(f.root, 'runtime-updates', 'active.json'), JSON.stringify({ root: runtime, version: '999.0.0' }));
  const selected = await status();
  assert.equal((selected.structured.pendingUpdate as { state?: string }).state, 'selected');
  assert.match(selected.text, /Runtime 999\.0\.0 is waiting: Selected\. GrantTap processes started on \d+\.\d+\.\d+, this MCP server included, run it from their next start\./);
  writeFileSync(join(f.root, 'runtime-updates', 'active.json'), JSON.stringify({ rejectedVersion: '999.0.0' }));
  assert.equal((await status()).structured.pendingUpdate, null, 'a release rolled back after a failed start is not offered');
});

test('the tool descriptions say what each tool does and returns', async t => {
  fixture(t);
  const server = createGrantTapServer(), client = await connectInMemory(server);
  try {
    const tools = new Map((await client.listTools()).tools.map(tool => [tool.name, tool.description ?? '']));
    assert.match(tools.get('connection_status')!, /phone messages are queued to reach it after this turn/);
    assert.match(tools.get('connection_status')!, /newer one waiting to take over/);
    assert.match(tools.get('connection_status')!, /Never creates, replaces or removes a pairing\./);
    assert.match(tools.get('connect')!, /Returns the same state as connection_status/);
    assert.match(tools.get('reconnect')!, /mode=add_device enrolls one more phone or iPad/);
    assert.match(tools.get('connect_with_passkey')!, /Returns passkeyUrl/);
    assert.match(tools.get('set_runtime_auto_update')!, /only when the person asks/);
    assert.match(tools.get('notify')!, /Nobody answers a status: use ask or ask_yes_no/);
    for (const name of ['ask', 'ask_yes_no']) assert.match(tools.get(name)!, /about three minutes by default/);
    const resources = (await client.listResources()).resources;
    assert.match(resources.find(item => item.uri === 'granttap://mesh/current')?.description ?? '',
      /when this server knows the calling chat/);
  } finally { await client.close(); await server.close(); }
});
