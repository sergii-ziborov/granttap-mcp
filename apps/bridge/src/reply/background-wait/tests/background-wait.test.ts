import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionInfo } from '../../../../../../packages/protocol/schema';
import { isDeliveryInFlight, queued } from '../../in-flight';
import { providerProcessEnvironment, runProcess } from '../../process';
import { CLAUDE_BACKGROUND_CEILING_MS, MESSAGE_WAIT_MS, messageWaitsBehindRun, withBackgroundCeiling } from '..';

const NOW = Date.UTC(2026, 10, 24, 15, 0, 0);
const MINUTE = 60_000;

const chat = (sessionId: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({ sessionId, agent: 'claude',
  cwd: '/work/app', state: 'working', startedAt: NOW - 3_600_000, lastActivityAt: NOW, tokensSession: 0,
  tokensLastTurn: 0, backgroundTasks: 2, ...extra });

/** A chat's run that only ends when stopped, as `claude -p` waiting for the agents its turn left. */
function longRun(key: string) {
  return queued(key, () => runProcess('/bin/sh', ['-c', 'exec sleep 30'], undefined, 60_000,
    () => ({ ok: true, text: 'unexpected' }), undefined, key));
}

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 10_000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(check(), what);
}

function quietMonitor(t: { mock: { method: (object: object, name: string, fn: (chunk: unknown) => boolean) => unknown } }) {
  const lines: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: unknown) => { lines.push(String(chunk)); return true; });
  return lines;
}

test('Claude Code keeps a phone run alive two hours for the agents its turn leaves, unless the computer says otherwise', () => {
  assert.equal(CLAUDE_BACKGROUND_CEILING_MS, 7_200_000);
  assert.equal(withBackgroundCeiling({ PATH: '/bin' }).CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, '7200000');
  assert.equal(withBackgroundCeiling({ CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' }).CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, '0',
    'a ceiling set on the computer is kept');
  assert.equal(withBackgroundCeiling({ CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '' }).CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS,
    '7200000', 'an empty setting is no setting');
  const prior = process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS;
  delete process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS;
  try {
    assert.equal(providerProcessEnvironment().CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, '7200000');
  } finally {
    if (prior !== undefined) process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = prior;
  }
});

test('a waiting message takes its chat back ten minutes after the turn, and the run ends through the chat history',
  { skip: process.platform === 'win32' }, async t => {
    const lines = quietMonitor(t);
    const run = longRun('chat-bg-a');
    await until(() => isDeliveryInFlight('chat-bg-a'), 'the run holds its chat');
    const ended = NOW - 4 * MINUTE;
    const going = chat('chat-bg-a', { backgroundTasks: undefined, lastActivityAt: ended });
    assert.equal(messageWaitsBehindRun('chat-bg-a', going, NOW), false, 'a turn still going is never stopped');
    assert.equal(messageWaitsBehindRun('chat-bg-a', chat('chat-bg-a', { agent: 'codex', lastActivityAt: ended }), NOW), false);
    assert.equal(messageWaitsBehindRun('chat-bg-a', undefined, NOW), false);
    assert.equal(messageWaitsBehindRun('chat-bg-a', chat('chat-bg-a', { lastActivityAt: ended }), NOW), false,
      'the agents have had four minutes');
    assert.equal(messageWaitsBehindRun('chat-bg-a', chat('chat-bg-a', { lastActivityAt: ended }), ended + MESSAGE_WAIT_MS), true);
    assert.equal(messageWaitsBehindRun('chat-bg-a', chat('chat-bg-a', { lastActivityAt: ended }), ended + MESSAGE_WAIT_MS + 1),
      false, 'a run already stopped is not stopped again while it exits');
    assert.deepEqual(await run, { ok: true, text: '', sessionId: 'chat-bg-a', delivery: 'native' });
    assert.equal(isDeliveryInFlight('chat-bg-a'), false, 'the message can have its chat');
    assert.ok(lines.some(line =>
      /^\[monitor\] A message waits for chat chat-bg-, .* stopped 10 min after the turn\.\n$/.test(line)));
  });

test('a turn that ended long ago gives way at once, and a message never waits more than ten minutes',
  { skip: process.platform === 'win32' }, async t => {
    quietMonitor(t);
    const old = longRun('chat-bg-b');
    await until(() => isDeliveryInFlight('chat-bg-b'), 'the run holds its chat');
    assert.equal(messageWaitsBehindRun('chat-bg-b', chat('chat-bg-b', { lastActivityAt: NOW - 45 * MINUTE }), NOW), true,
      'before, Claude Code had stopped this work 35 minutes ago');
    assert.equal((await old).ok, true);
    const busy = longRun('chat-bg-c');
    await until(() => isDeliveryInFlight('chat-bg-c'), 'the run holds its chat');
    const later = chat('chat-bg-c', { lastActivityAt: NOW + 30 * MINUTE });
    assert.equal(messageWaitsBehindRun('chat-bg-c', later, NOW), false, 'first seen waiting now');
    assert.equal(messageWaitsBehindRun('chat-bg-c', later, NOW + 9 * MINUTE), false);
    assert.equal(messageWaitsBehindRun('chat-bg-c', later, NOW + 10 * MINUTE), true);
    assert.equal((await busy).ok, true);
    assert.equal(messageWaitsBehindRun('chat-bg-c', later, NOW + 11 * MINUTE), false, 'nothing runs for the chat any more');
  });
