import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { generateKeyPair } from '../../../../../../packages/core/crypto';
import type { TaskDispatch } from '../../../../../../packages/protocol/schema';
import { rememberPublishedCatalog } from '../../../session-catalog';
import { visibleUserText } from '../../../sessions/support/activity-helpers';
import { TaskDispatchInbox } from '../../../task-dispatch';
import { queueNote } from '../../../task-dispatch/queue-note';
import { queuedForMessage } from '../../../task-dispatch/worker/queue-depth';
import { PreparedTaskTransfers } from '../../../task-transfer';
import { handleInboundUserMessage } from '../../message-delivery';

const room = 'queue-note-paths-room';
const phone = generateKeyPair().publicKey;

/** A Claude Code stand-in that answers with its prompt, slowly for the first message so the next ones queue. */
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-queue-note-paths-'));
  const stub = join(root, 'claude-stub');
  writeFileSync(stub, ['#!/usr/bin/env node', 'const prompt = process.argv.at(-1);',
    "setTimeout(() => process.stdout.write(JSON.stringify({ result: prompt })), prompt.startsWith('First') ? 600 : 0);"].join('\n'),
  { mode: 0o755 });
  const prior = { config: process.env.GRANTTAP_CONFIG_DIR, claude: process.env.GRANTTAP_CLAUDE_BIN };
  process.env.GRANTTAP_CONFIG_DIR = root;
  process.env.GRANTTAP_CLAUDE_BIN = stub;
  t.after(() => {
    for (const [name, value] of [['GRANTTAP_CONFIG_DIR', prior.config], ['GRANTTAP_CLAUDE_BIN', prior.claude]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const said: string[] = [];
  const record = async (payload: { type?: string; kind?: string; text?: string }) => {
    if (payload.type === 'agent.event' && payload.kind === 'response' && payload.text) said.push(payload.text);
  };
  const client = { room, isConnected: true, setSessionKey: () => {}, send: record, sendSession: record };
  rememberPublishedCatalog(client as never, { type: 'sessions.status', machine: 'Fixture Mac', generatedAt: Date.now(),
    sessions: [{ sessionId: 'direct-chat', agent: 'claude', state: 'idle', startedAt: 1, lastActivityAt: 2,
      tokensSession: 0, tokensLastTurn: 0, cwd: root }] });
  return { root, client, said };
}

function job(sessionId: string, messageId: string, extra: Partial<TaskDispatch> = {}): TaskDispatch {
  const now = Date.now();
  return { type: 'task.dispatch', jobId: `${messageId}-job`.padEnd(12, '0'), token: 'd'.repeat(64), sessionId, notBefore: now,
    expiresAt: now + 86_400_000, createdAt: now,
    operation: { type: 'user.message', sessionId, messageId, text: 'Synthetic follow-up', createdAt: now }, ...extra };
}

const direct = (f: ReturnType<typeof fixture>, messageId: string, text: string) => handleInboundUserMessage(f.client as never,
  { type: 'user.message', sessionId: 'direct-chat', messageId, text, createdAt: Date.now() }, async () => {}, phone);

test('a message that reached the computer directly hears of the queued messages and those waiting behind it', async t => {
  const f = fixture(t);
  const inbox = new TaskDispatchInbox(join(f.root, 'task-dispatch'), room);
  inbox.stage(job('direct-chat', 'queued-other'), phone);
  inbox.stage(job('another-chat', 'queued-elsewhere'), phone);
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const first = direct(f, 'direct-first', 'First change the parser');
  await pause(150);
  const second = direct(f, 'direct-second', 'Then rename its tests');
  await pause(50);
  const third = direct(f, 'direct-third', 'Then update the changelog');
  await Promise.all([first, second, third]);
  assert.deepEqual(f.said, [
    `First change the parser\n\n${queueNote(1)}`,
    `Then rename its tests\n\n${queueNote(2)}`,
    `Then update the changelog\n\n${queueNote(1)}`,
  ], 'the queued message of the same chat is counted, and so are the messages waiting here behind a run');
  assert.deepEqual(f.said.map(visibleUserText),
    ['First change the parser', 'Then rename its tests', 'Then update the changelog']);
  assert.equal(queuedForMessage(room, { sessionId: 'direct-chat', messageId: 'queued-other' }, join(f.root, 'task-dispatch')), 0,
    'a queued copy of the message being delivered is not one more');
});

test('a direct new task counts the follow-ups written for it, and nothing for another chat', t => {
  const f = fixture(t);
  const inbox = new TaskDispatchInbox(join(f.root, 'task-dispatch'), room);
  const now = Date.now();
  const followUp = (origin: string, id: string): TaskDispatch => ({ type: 'task.dispatch', jobId: `${id}-job`.padEnd(12, '0'),
    token: 'e'.repeat(64), notBefore: now, expiresAt: now + 86_400_000, createdAt: now,
    operation: { type: 'user.message.continue', agent: 'claude', originMessageId: origin, messageId: id, text: 'And then this',
      createdAt: now } });
  inbox.stage(followUp('origin-1', 'follow-up-1'), phone);
  inbox.stage(followUp('origin-1', 'follow-up-2'), phone);
  inbox.stage(followUp('origin-2', 'follow-up-3'), phone);
  assert.equal(queuedForMessage(room, { taskOriginId: 'origin-1', peerPublicKey: phone }, join(f.root, 'task-dispatch')), 2);
  assert.equal(queuedForMessage(room, { taskOriginId: 'origin-1', peerPublicKey: generateKeyPair().publicKey },
    join(f.root, 'task-dispatch')), 0, "another phone's follow-ups are its own task's");
  assert.equal(queuedForMessage(room, {}, join(f.root, 'task-dispatch')), 0);
});

test('a moved Task hears of the queue on its first turn and on the next ones, after the whole prompt', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-transfer-note-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const transfers = new PreparedTaskTransfers(root);
  const capsule = { taskId: 'task-fixture', goal: 'Synthetic task', currentStatus: 'Ready', sourceProvider: 'codex' as const,
    sourceComputer: 'computer-source', targetProvider: 'claude' as const, targetComputer: 'computer-target',
    repository: 'repo-fixture', baseSha: 'a'.repeat(40), workingTree: 'clean' as const, filesChanged: [], dependencies: [],
    resourceClaims: [], remainingWork: ['Verify'], importantDecisions: [], createdAt: 1 };
  const row = transfers.prepare({ eventId: 'transfer-note', projectId: 'project-fixture', title: 'Moved task',
    sourceSessionId: 'source-chat', capsule, workspace: '/fixture/worktree', branch: 'granttap/fixture',
    context: 'USER: Synthetic request', acceptedAt: 1 });
  const prompts: string[] = [];
  const provider = {
    start: async (request: { text: string }) => { prompts.push(request.text); return { ok: true as const, sessionId: 'native-chat', text: 'ok' }; },
    resume: async (_session: unknown, text: string) => { prompts.push(text); return { ok: true as const, text: 'ok' }; },
  };
  await transfers.deliver(row.sessionId, 'Continue with the parser', [], { queuedBehind: 2 }, provider);
  await transfers.deliver(row.sessionId, 'Now the tests', [], { queuedBehind: 1 }, provider);
  await transfers.deliver(row.sessionId, 'Last one', [], {}, provider);
  assert.ok(prompts[0]!.endsWith(`</current-user-request>\n\n${queueNote(2)}`), 'the line closes the opening prompt');
  assert.ok(visibleUserText(prompts[0]).endsWith('</current-user-request>'), 'and the transcript views remove it');
  assert.deepEqual(prompts.slice(1), [`Now the tests\n\n${queueNote(1)}`, 'Last one']);
});
