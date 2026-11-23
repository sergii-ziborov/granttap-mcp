import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createGrantTapServer } from '../../http/create-server';
import { connectInMemory, textResult } from '../../../../../tests/support/mcp-client';
import { createPairing, machineConfigPath, saveConfig } from '../../../../bridge/src/config';
import { recordPhoneSeen } from '../../../../bridge/src/pairing/presence';
import { phoneId } from '../../../../bridge/src/paired-phones';
import { writeLimitContinuationState } from '../../../../bridge/src/limit-continuation/store';
import { setRuntimeAutoUpdate } from '../../../../bridge/src/runtime-updates';
import { writeHoldState } from '../../../../bridge/src/runtime-updates/drain/state';
import { TaskDispatchInbox } from '../../../../bridge/src/task-dispatch';
import { generateKeyPair } from '../../../../../packages/core/crypto';
import type { TaskDispatch } from '../../../../../packages/protocol/schema';
import { recordAttributedCall } from '../../../../bridge/src/mesh/identity/call-scope';
import { setChatProcessProbe } from '../../chat-identity';

const chat = 'status-details-chat';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-status-details-'));
  const keys = ['GRANTTAP_CONFIG_DIR', 'CLAUDE_CODE_SESSION_ID', 'GROK_SESSION_ID', 'CODEX_THREAD_ID'] as const;
  const previous = keys.map(key => process.env[key]);
  for (const key of keys) delete process.env[key];
  process.env.GRANTTAP_CONFIG_DIR = root;
  process.env.CLAUDE_CODE_SESSION_ID = chat;
  t.after(() => {
    setChatProcessProbe();
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
  writeLimitContinuationState({ off: [], scheduled: { [chat]: { resetsAt, scope: { sessionId: chat, provider: 'claude' },
    scheduledAt: Date.now(), regular: { messageId: 'limit-continue-fixture', notBefore: resetsAt + 60_000, onRelay: true } } } });
  const before = readdirSync(f.root, { recursive: true }).sort();
  const first = await status();
  assert.deepEqual(first.structured.chat, { sessionId: chat, provider: 'claude', identifiedBy: 'environment',
    queuedPhoneMessages: 2, autoContinue: true, continuation: { dueAt: resetsAt + 60_000, early: false } });
  assert.match(first.text, /This chat: 2 phone messages are queued to reach it after this turn; a continuation after a subscription limit is queued for it, due /);
  assert.match(first.text, /Paired phones: 1 — 0 active in the last minute, 0 more seen in the last 7 days, 1 not seen for 7 days or never\./);
  assert.deepEqual(readdirSync(f.root, { recursive: true }).sort(), before, 'reading the status wrote nothing');
  writeLimitContinuationState({ off: [chat], scheduled: {} });
  const off = await status();
  assert.deepEqual(off.structured.chat, { sessionId: chat, provider: 'claude', identifiedBy: 'environment',
    queuedPhoneMessages: 2, autoContinue: false, continuation: null });
  assert.match(off.text, /it does not continue by itself after a subscription limit/);
  delete process.env.CLAUDE_CODE_SESSION_ID;
  const unbound = await status();
  assert.equal(unbound.structured.chat, null, 'without a chat in its environment the server guesses none');
  assert.doesNotMatch(unbound.text, /This chat:/);
});

test('a Codex chat is told its queue by the rollout its Codex holds open, a Cursor chat by its hook', async t => {
  const f = fixture(t), thread = '019a7c1e-aaaa-7bbb-8ccc-0123456789ab';
  delete process.env.CLAUDE_CODE_SESSION_ID;
  queue(f.root, f.room, [thread, thread, thread, 'cursor-chat-0001']);
  setChatProcessProbe({ host: () => ({ host: 'codex', pid: 4242 }),
    openFiles: () => [`/Users/someone/.codex/sessions/2026/11/17/rollout-2026-11-17T02-14-08-${thread}.jsonl`] });
  const codex = await status();
  assert.deepEqual(codex.structured.chat, { sessionId: thread, provider: 'codex', identifiedBy: 'transcript',
    queuedPhoneMessages: 3, autoContinue: true, continuation: null });
  assert.match(codex.text, /This chat: 3 phone messages are queued to reach it after this turn/);
  setChatProcessProbe({ host: () => ({ host: 'cursor', pid: 4343 }), openFiles: () => [] });
  assert.equal((await status()).structured.chat, null, 'a Cursor server is shared by its chats and names none by itself');
  recordAttributedCall({ provider: 'cursor', sessionId: 'cursor-chat-0001', toolName: 'connection_status', args: {} });
  assert.deepEqual((await status()).structured.chat, { sessionId: 'cursor-chat-0001', provider: 'cursor', identifiedBy: 'hook',
    queuedPhoneMessages: 1, autoContinue: true, continuation: null }, 'the hook that ran inside the chat names it');
  assert.equal((await status()).structured.chat, null, 'a hook record names one call, not the next');
  process.env.CLAUDE_CODE_SESSION_ID = chat;
  setChatProcessProbe({ host: () => ({ host: 'claude', pid: 4444 }), openFiles: () => [] });
  recordAttributedCall({ provider: 'cursor', sessionId: 'cursor-chat-0001', toolName: 'connection_status', args: {} });
  assert.equal(((await status()).structured.chat as { sessionId?: string }).sessionId, chat,
    "a server that knows its chat never takes another chat's record");
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
  assert.match(downloaded.text, /Runtime 999\.0\.0 is waiting: Downloaded\. It takes over once the monitor's work that cannot be handed over has ended; new phone messages wait for that at most 10 min at a time, and running chats are taken over by it\./);
  const since = Date.UTC(2026, 10, 17, 9, 30);
  writeHoldState(join(f.root, 'runtime-updates'), { version: '999.0.0', phase: 'holding', since, holdUntil: since + 600_000,
    attempts: 0, blockers: [{ kind: 'run', sessionId: 'cursor-chat-0001', since }], survivingRuns: 2, updatedAt: since });
  const held = await status();
  assert.deepEqual((held.structured.pendingUpdate as { hold?: { phase: string; survivingRuns: number } }).hold?.phase, 'holding');
  assert.match(held.text, /Runtime 999\.0\.0 is waiting: Downloaded\. New phone messages wait for it since 09:30 UTC, until 09:40 UTC at the latest; it waits for a run in chat cursor-c \(since 09:30 UTC\)\. 2 running chats keep going and are taken over by the new version\./);
  writeHoldState(join(f.root, 'runtime-updates'), undefined);
  setRuntimeAutoUpdate(false);
  assert.match((await status()).text, /Runtime 999\.0\.0 is waiting: Downloaded, but automatic updates are off/);
  writeFileSync(join(f.root, 'runtime-updates', 'active.json'), JSON.stringify({ root: runtime, version: '999.0.0' }));
  const selected = await status();
  assert.equal((selected.structured.pendingUpdate as { state?: string }).state, 'selected');
  assert.match(selected.text, /Runtime 999\.0\.0 is waiting: Selected\. GrantTap processes started on \d+\.\d+\.\d+, this MCP server included, run it from their next start\./);
  writeFileSync(join(f.root, 'runtime-updates', 'active.json'), JSON.stringify({ rejectedVersion: '999.0.0' }));
  assert.equal((await status()).structured.pendingUpdate, null, 'a release rolled back after a failed start is not offered');
});

test('status lists each phone with the id remove_phones takes, and says which ones look unused', async t => {
  const f = fixture(t);
  const extra = generateKeyPair().publicKey;
  writeFileSync(join(f.root, 'pending-controllers.json'), '[]\n');
  saveConfig(machineConfigPath(), { ...createPairing('ws://127.0.0.1:1').machineCfg, room: f.room, extraPeerPublicKeys: [extra] });
  recordPhoneSeen(Date.now() - 5 * 60_000, extra);
  const { structured, text } = await status();
  const phones = structured.phones as Array<{ id: string; label: string; primary: boolean; addedAt: number | null;
    mostRecent: boolean; stale: boolean }>;
  assert.equal(phones[1]?.id, phoneId(extra));
  assert.deepEqual(phones.map(phone => phone.primary), [true, false]);
  assert.deepEqual(phones.map(phone => phone.mostRecent), [false, true]);
  assert.deepEqual(phones.map(phone => phone.stale), [true, false]);
  assert.match(text, new RegExp(`- First pairing · id ${phones[0]!.label} · never seen`));
  assert.match(text, new RegExp(`- Phone ${phones[1]!.label} · id ${phones[1]!.label} · last seen 5 min ago`));
  assert.match(text, /1 not seen for 30 days or never; remove_phones with notSeenForDays 30 asks the person on a phone to remove them\./);
});

test('every phone away for 30 days still keeps the most recent one out of the stale count', async t => {
  const f = fixture(t);
  const extras = [generateKeyPair().publicKey, generateKeyPair().publicKey];
  writeFileSync(join(f.root, 'pending-controllers.json'), '[]\n');
  saveConfig(machineConfigPath(), { ...createPairing('ws://127.0.0.1:1').machineCfg, room: f.room, extraPeerPublicKeys: extras });
  recordPhoneSeen(Date.now() - 40 * 86_400_000, extras[0]);
  recordPhoneSeen(Date.now() - 90 * 86_400_000, extras[1]);
  const { structured, text } = await status();
  const phones = structured.phones as Array<{ mostRecent: boolean; stale: boolean }>;
  assert.deepEqual(phones.map(phone => phone.mostRecent), [false, true, false]);
  assert.deepEqual(phones.map(phone => phone.stale), [true, false, true]);
  assert.match(text, /^2 not seen for 30 days or never;/m);
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
    assert.match(tools.get('connection_status')!, /pass ids of unused ones to remove_phones/);
    assert.match(tools.get('remove_phones')!, /The phone that answers, any phone that reaches this computer while the question is open, and the last phone always stay/);
    assert.match(tools.get('connect_with_passkey')!, /Returns passkeyUrl/);
    assert.match(tools.get('set_runtime_auto_update')!, /only when the person asks/);
    assert.match(tools.get('notify')!, /Nobody answers a status: use ask or ask_yes_no/);
    for (const name of ['ask', 'ask_yes_no']) assert.match(tools.get(name)!, /about three minutes by default/);
    const resources = (await client.listResources()).resources;
    assert.match(resources.find(item => item.uri === 'granttap://mesh/current')?.description ?? '',
      /when this server knows the calling chat/);
  } finally { await client.close(); await server.close(); }
});
