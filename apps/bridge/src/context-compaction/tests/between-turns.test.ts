import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SessionInfo } from '../../../../../packages/protocol/schema';
import { queued } from '../../reply/in-flight';
import { readCompactionState } from '../store';
import { autoCompactDue, scheduleAutoCompactions, setAutoCompact } from '..';
import { fakeClaude } from './fake-claude';

const now = Date.now();
const MINUTE = 60_000;

function isolated(t: test.TestContext): { root: string; sessions: string } {
  const root = mkdtempSync(join(tmpdir(), 'granttap-auto-compact-'));
  const sessions = join(root, 'claude-sessions');
  mkdirSync(sessions);
  const prior = { config: process.env.GRANTTAP_CONFIG_DIR, held: process.env.GRANTTAP_CLAUDE_SESSIONS_DIR };
  Object.assign(process.env, { GRANTTAP_CONFIG_DIR: join(root, 'config'), GRANTTAP_CLAUDE_SESSIONS_DIR: sessions });
  t.after(() => {
    for (const [key, value] of [['GRANTTAP_CONFIG_DIR', prior.config], ['GRANTTAP_CLAUDE_SESSIONS_DIR', prior.held]] as const) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, sessions };
}

/** A Claude chat whose last turn ended a minute ago with this much in its window. */
function chat(sessionId: string, usedTokens: number, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { sessionId, agent: 'claude', cwd: tmpdir(), state: 'idle', startedAt: now - 60 * MINUTE,
    lastActivityAt: now - MINUTE, tokensSession: 0, tokensLastTurn: 0,
    contextUsage: { observedAt: now - MINUTE, source: 'claude', usedTokens, parts: [] }, ...extra };
}

test('the threshold is only reached between turns, by a fresh reading of its own', () => {
  const facts = { now, atTokens: 400_000, busy: false };
  assert.equal(autoCompactDue(chat('a', 450_000), facts), true);
  assert.equal(autoCompactDue(chat('a', 399_999), facts), false, 'under the threshold');
  assert.equal(autoCompactDue(chat('a', 450_000), { ...facts, atTokens: undefined }), false, 'turned off');
  assert.equal(autoCompactDue(chat('a', 450_000, { state: 'working' }), facts), false, 'never during a turn');
  assert.equal(autoCompactDue(chat('a', 450_000, { state: 'waiting' }), facts), false, 'never while it waits on an approval');
  assert.equal(autoCompactDue(chat('a', 450_000), { ...facts, busy: true }), false, 'never while a run or Claude Code holds it');
  assert.equal(autoCompactDue(chat('a', 450_000, { lastActivityAt: now - 5_000 }), facts), false,
    'a turn that just ended lets the next queued message go first');
  assert.equal(autoCompactDue(chat('a', 450_000, { paused: true }), facts), false);
  assert.equal(autoCompactDue(chat('a', 450_000, { backgroundTasks: 1 }), facts), false, 'its background work is still running');
  assert.equal(autoCompactDue(chat('a', 450_000, { usageLimit: { resetsAt: now + MINUTE } }), facts), false);
  assert.equal(autoCompactDue(chat('a', 450_000, { stopped: { reason: 'sign_in', at: now } }), facts), false);
  assert.equal(autoCompactDue(chat('a', 450_000, { stopped: { reason: 'context_window', at: now } }), facts), true,
    'a chat that ran out of room is exactly the one to compact');
  const stale = chat('a', 450_000, { lastActivityAt: now - 3 * 60 * MINUTE });
  stale.contextUsage!.observedAt = now - 3 * 60 * MINUTE;
  assert.equal(autoCompactDue(stale, facts), false, 'a chat left hours ago is not woken up');
  assert.equal(autoCompactDue(chat('a', 450_000, { compaction: { count: 1, last: { at: now - MINUTE, trigger: 'threshold' } } }), facts),
    false, 'the reading is not newer than the last compaction');
  assert.equal(autoCompactDue(chat('a', 450_000), { ...facts, triedReading: now - MINUTE }), false, 'each reading is tried once');
  assert.equal(autoCompactDue(chat('a', 450_000, { agent: 'grok' }), facts), false);
});

test('a Claude chat over its threshold after a turn is compacted once, and never while a run holds it', async (t) => {
  const { sessions } = isolated(t);
  const claude = fakeClaude();
  t.after(() => claude.done());

  await scheduleAutoCompactions([chat('below', 399_000), chat('busy', 900_000, { state: 'working' })], now);
  assert.equal(claude.calls().length, 0, 'nothing reached the default 400k threshold between turns');

  let release!: () => void;
  const turn = queued('held', () => new Promise((resolve) => { release = () => resolve({ ok: true, text: '' }); }));
  await scheduleAutoCompactions([chat('held', 700_000)], now);
  assert.equal(claude.calls().length, 0, 'a GrantTap turn still running in the chat holds the compaction back');
  release();
  await turn;

  writeFileSync(join(sessions, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'open', kind: 'interactive' }));
  await scheduleAutoCompactions([chat('open', 700_000)], now);
  assert.equal(claude.calls().length, 0, 'a chat open in Claude Code on the computer is left alone');

  await scheduleAutoCompactions([chat('held', 700_000)], now);
  assert.deepEqual(claude.calls().map((call) => call.args[2]), ['held']);
  const state = readCompactionState();
  assert.equal(state.triedReading?.held, now - MINUTE);
  assert.deepEqual(state.runs.held?.map((run) => [run.by, run.ok, run.preTokens, run.postTokens]),
    [['threshold', true, 612_002, 31_400]]);

  await scheduleAutoCompactions([chat('held', 700_000)], now + MINUTE);
  assert.equal(claude.calls().length, 1, 'the same reading is not compacted twice');
});

test('a threshold set from the phone replaces the default, and off turns it off', async (t) => {
  isolated(t);
  const claude = fakeClaude();
  t.after(() => claude.done());
  setAutoCompact('custom', true, 200_000);
  setAutoCompact('off', false);
  await scheduleAutoCompactions([chat('off', 900_000), chat('custom', 250_000)], now);
  assert.deepEqual(claude.calls().map((call) => call.args[2]), ['custom']);
  setAutoCompact('custom', true);
  assert.equal(readCompactionState().thresholds.custom, undefined, 'without tokens it goes back to the default');
  const codex = chat('codex-chat', 250_000, { agent: 'codex' });
  await scheduleAutoCompactions([codex], now);
  assert.equal(claude.calls().length, 1, 'Codex has no default: it compacts itself near its window');
});
