import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SessionInfo, UserMessage } from '../../../../../packages/protocol/schema';
import { setSessionPaused } from '../../config';
import { setAutoContinue } from '../../limit-continuation';
import { runProcess } from '../../reply/process';
import type { NativeQueueScope } from '../../task-dispatch/sender/store';
import { backgroundContinuePrompt, CONTINUE_LIMIT, CONTINUE_WINDOW_MS, continueStoppedWork, isBackgroundContinuation,
  noteProviderRunEnded, registerStoppedWorkHandler, stoppedBackgroundWork, type StoppedChat } from '..';

/** What Claude Code 2.1.330 writes to stderr when `claude -p` stops the background work its last turn left. */
const CLAUDE_LINE = 'Background tasks still running 10m after the last turn (3 agents: "Synthetic site API", '
  + '"Synthetic SDK", "Synthetic app"); stopping them. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.\n';
const NOW = Date.UTC(2026, 10, 24, 0, 22, 11);

type TestContext = { after: (fn: () => void) => void;
  mock: { method: (object: object, name: string, fn: (chunk: unknown) => boolean) => unknown } };

/** A computer of its own, whose monitor log lines are kept for the test instead of printed. */
function computer(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: unknown) => {
    for (const line of String(chunk).split('\n')) if (line.startsWith('[monitor]')) lines.push(line);
    return true;
  });
  const root = mkdtempSync(join(tmpdir(), 'granttap-background-continuation-')), prior = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => {
    if (prior === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  });
  return lines;
}

const chat = (extra: Partial<SessionInfo> = {}): SessionInfo => ({ sessionId: 'synthetic-chat-1', agent: 'claude',
  cwd: '/work/app', state: 'idle', startedAt: NOW - 3_600_000, lastActivityAt: NOW - 600_000, tokensSession: 0,
  tokensLastTurn: 0, projectId: 'project-synthetic', ...extra });
const stopped = (session = chat(), phoneMessagesWaiting = 0): StoppedChat =>
  ({ sessionId: session.sessionId, session, phoneMessagesWaiting });

function relay() {
  const queued: Array<{ scope: NativeQueueScope; message: UserMessage; notBefore: number }> = [];
  return { queued, submit: async (scope: NativeQueueScope, message: UserMessage, notBefore: number) => {
    queued.push({ scope, message, notBefore });
  } };
}

test('Claude\'s own line says the background work was stopped and how long after the turn', () => {
  assert.deepEqual(stoppedBackgroundWork(`Some warning\n${CLAUDE_LINE}`), { after: '10m' });
  assert.equal(stoppedBackgroundWork('Background tasks finished.\n'), undefined);
  assert.equal(stoppedBackgroundWork(''), undefined);
});

test('a chat whose background work Claude stopped is continued at once, through the relay queue', async t => {
  const log = computer(t);
  const { queued, submit } = relay();
  assert.equal(await continueStoppedWork(submit, stopped(), { after: '10m' }, NOW), true);
  assert.equal(queued.length, 1);
  const [{ scope, message, notBefore }] = queued as [typeof queued[number]];
  assert.deepEqual(scope, { sessionId: 'synthetic-chat-1', provider: 'claude', projectId: 'project-synthetic' });
  assert.equal(notBefore, NOW);
  assert.equal(message.text, backgroundContinuePrompt('10m'));
  assert.equal(message.cwd, '/work/app');
  assert.ok(isBackgroundContinuation(message));
  assert.match(message.text, /keep long work inside the turn/, 'the next turn is told why, so it does not end early again');
  assert.deepEqual(log, ['[monitor] Claude Code stopped the background work of chat syntheti 10m after its turn: '
    + 'a continuation is queued.'], 'one line, naming the chat by the start of its id and never its words');
});

test('a chat a phone message waits for, a paused chat and one turned off on the phone are not continued', async t => {
  const log = computer(t);
  const { queued, submit } = relay();
  assert.equal(await continueStoppedWork(submit, stopped(chat(), 1), { after: '10m' }, NOW), false,
    'the person\'s message resumes it, and Claude tells that turn what it stopped');
  setSessionPaused('synthetic-chat-1', true);
  assert.equal(await continueStoppedWork(submit, stopped(), { after: '10m' }, NOW), false);
  setSessionPaused('synthetic-chat-1', false);
  setAutoContinue('synthetic-chat-1', false);
  assert.equal(await continueStoppedWork(submit, stopped(), { after: '10m' }, NOW), false);
  assert.equal(await continueStoppedWork(submit, { sessionId: 'unlisted', phoneMessagesWaiting: 0 }, { after: '10m' }, NOW), false);
  assert.equal(await continueStoppedWork(submit, stopped(chat({ sessionId: 'codex-1', agent: 'codex' })), { after: '10m' }, NOW), false);
  assert.equal(queued.length, 0);
  assert.equal(log.length, 5);
  assert.match(log[0]!, /not continued: a message from the phone waits for it/);
  assert.match(log[2]!, /not continued: continuing by itself is turned off for it on the phone/);
});

test('work that keeps being stopped is continued a few times, then waits for the person', async t => {
  const log = computer(t);
  const { queued, submit } = relay();
  for (let turn = 0; turn < CONTINUE_LIMIT + 1; turn += 1) {
    await continueStoppedWork(submit, stopped(), { after: '10m' }, NOW + turn * 15 * 60_000);
  }
  assert.equal(queued.length, CONTINUE_LIMIT);
  assert.match(log.at(-1)!, /not continued: it was continued 3 times in the last 6 hours\.$/);
  assert.equal(await continueStoppedWork(submit, stopped(), { after: '10m' }, NOW + CONTINUE_WINDOW_MS + 60_000), true,
    'the window moved on');
});

test('a relay that refuses the continuation still counts it, so a failing relay cannot repeat it past the limit', async t => {
  computer(t);
  const failing = async () => { throw new Error('relay unavailable'); };
  for (let turn = 0; turn < CONTINUE_LIMIT; turn += 1) {
    assert.equal(await continueStoppedWork(failing, stopped(), { after: '10m' }, NOW + turn * 60_000), false);
  }
  const { queued, submit } = relay();
  await continueStoppedWork(submit, stopped(), { after: '10m' }, NOW + 10 * 60_000);
  assert.equal(queued.length, 0);
});

test('a run\'s end names the chat: its own key, or the new task its answer started', t => {
  const told: string[] = [];
  registerStoppedWorkHandler((sessionId) => { told.push(sessionId); });
  t.after(() => registerStoppedWorkHandler(undefined));
  noteProviderRunEnded({ key: 'chat-a', stderr: CLAUDE_LINE, result: { ok: true, text: 'done' } });
  noteProviderRunEnded({ key: '__new_claude_task__:op-1', stderr: CLAUDE_LINE,
    result: { ok: true, text: 'done', sessionId: 'new-chat-b' } });
  noteProviderRunEnded({ key: 'transfer-' + 'a'.repeat(48), stderr: CLAUDE_LINE, result: { ok: true, text: '' } });
  noteProviderRunEnded({ key: 'chat-c', stderr: 'nothing stopped\n', result: { ok: true, text: 'done' } });
  noteProviderRunEnded({ key: '__new_claude_task__:op-2', stderr: CLAUDE_LINE, result: { ok: false, error: 'failed' } });
  assert.deepEqual(told, ['chat-a', 'new-chat-b']);
});

test('a provider process that printed Claude\'s line tells the monitor when it ends', { skip: process.platform === 'win32' }, async t => {
  const told: string[] = [];
  registerStoppedWorkHandler((sessionId, work) => { told.push(`${sessionId} ${work.after}`); });
  t.after(() => registerStoppedWorkHandler(undefined));
  const result = await runProcess('/bin/sh', ['-c', `printf '%s' "$LINE" >&2; printf 'answer'`], undefined, 10_000,
    stdout => ({ ok: true, text: stdout }), undefined, 'chat-from-phone');
  assert.deepEqual(result, { ok: true, text: 'answer' });
  assert.deepEqual(told, [], 'the line was not in the environment, so nothing was printed');
  process.env.LINE = CLAUDE_LINE;
  t.after(() => { delete process.env.LINE; });
  await runProcess('/bin/sh', ['-c', `printf '%s' "$LINE" >&2; printf 'answer'`], undefined, 10_000,
    stdout => ({ ok: true, text: stdout }), undefined, 'chat-from-phone');
  assert.deepEqual(told, ['chat-from-phone 10m']);
});
