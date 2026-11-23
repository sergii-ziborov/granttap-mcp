import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Payload, SessionInfo } from '../../../../../packages/protocol/schema';
import { updateCompactionState } from '../store';
import { claudeSessionHeld } from '../trigger';
import { annotateCompactionCatalog, autoCompactThreshold, compactChat, compactedText, setAutoCompact } from '..';
import { fakeClaude } from './fake-claude';

const now = Date.now();

function configured(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'granttap-compaction-catalog-'));
  const prior = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = join(root, 'config');
  process.env.GRANTTAP_CLAUDE_SESSIONS_DIR = join(root, 'none');
  t.after(() => {
    if (prior == null) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = prior;
    delete process.env.GRANTTAP_CLAUDE_SESSIONS_DIR;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

const row = (sessionId: string, agent: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({ sessionId, agent,
  state: 'idle', startedAt: now - 10_000, lastActivityAt: now - 5_000, tokensSession: 0, tokensLastTurn: 0, ...extra });

test("the phone learns each chat's compactions, who made the newest and its threshold", (t) => {
  configured(t);
  updateCompactionState((state) => {
    state.runs.mine = [{ by: 'phone', startedAt: now - 60_000, endedAt: now - 50_000, ok: true, preTokens: 612_002, postTokens: 31_400 }];
    state.runs.pending = [{ by: 'threshold', startedAt: now - 9_000, endedAt: now - 8_000, ok: true, preTokens: 500_000, postTokens: 20_000 },
      { by: 'phone', startedAt: now - 7_000, endedAt: now - 6_000, ok: false, error: 'refused' }];
  });
  setAutoCompact('off', false);
  setAutoCompact('mine', true, 250_000);
  const status = annotateCompactionCatalog({
    sessions: [
      row('mine', 'claude', { compaction: { count: 3, last: { at: now - 52_000, trigger: 'manual' } } }),
      row('pending', 'claude', { compaction: { count: 2, last: { at: now - 3_600_000, trigger: 'auto', preTokens: 967_000 } } }),
      row('off', 'claude'), row('codex', 'codex'), row('grok', 'grok'),
    ],
    history: [row('old', 'claude')],
  });
  const [mine, pending, off, codex, grok] = status.sessions;
  assert.deepEqual(mine!.compaction, { count: 3, last: { at: now - 52_000, trigger: 'phone', preTokens: 612_002, postTokens: 31_400 },
    autoAtTokens: 250_000, autoAtDefault: false }, "the transcript's manual /compact was the phone's");
  assert.deepEqual(pending!.compaction, { count: 3, last: { at: now - 8_000, trigger: 'threshold', preTokens: 500_000, postTokens: 20_000 },
    autoAtTokens: 400_000, autoAtDefault: true }, 'a run the transcript does not show yet is counted, a failed one is not');
  assert.deepEqual(off!.compaction, { count: 0, autoAtDefault: false });
  assert.deepEqual(codex!.compaction, { count: 0, autoAtDefault: true }, 'Codex is off unless the person sets it');
  assert.equal(grok!.compaction, undefined, 'Grok has no compaction GrantTap can run');
  assert.equal(status.history![0]!.compaction?.autoAtTokens, 400_000);
  for (const session of [...status.sessions, ...status.history!]) assert.equal(SessionInfo.safeParse(session).success, true);
  assert.deepEqual(autoCompactThreshold({ sessionId: 'x', agent: 'claude' }), { atTokens: 400_000, isDefault: true });
});

test("the phone's threshold message is strict about what a threshold can be", () => {
  const set = (extra: Record<string, unknown>) => Payload.safeParse({ type: 'session.autocompact.set', sessionId: 'chat-1234',
    enabled: true, createdAt: now, ...extra }).success;
  assert.equal(set({}), true, 'on without tokens is back to the default');
  assert.equal(set({ atTokens: 250_000 }), true);
  assert.equal(set({ enabled: false }), true);
  assert.equal(set({ atTokens: 10_000 }), false, 'under 50k compacts after almost every turn');
  assert.equal(set({ atTokens: 20_000_000 }), false);
  assert.equal(set({ atTokens: 250_000.5 }), false);
  assert.equal(set({ extra: true }), false);
});

test('Compact now from the phone runs Claude Code once, says what it did and refuses during a turn', async (t) => {
  const root = configured(t);
  const claude = fakeClaude();
  t.after(() => claude.done());
  const chat = row('phone-chat', 'claude', { cwd: root });
  const working = await compactChat({ ...chat, state: 'working' }, 'phone');
  assert.deepEqual(working, { ok: false, error: 'Wait for the active Claude Code turn to finish before compacting it.', refused: true });
  assert.equal(compactedText(chat, working), 'Wait for the active Claude Code turn to finish before compacting it.', 'it did not fail: it did not run');
  const outcome = await compactChat(chat, 'phone');
  assert.equal(compactedText(chat, outcome), 'Claude Code compacted the context: 612k → 31k tokens. The chat continues from its summary.');
  assert.equal(claude.calls().length, 1);
  const during = compactChat(chat, 'phone');
  const twice = await compactChat(chat, 'phone');
  assert.deepEqual(twice, { ok: false, error: 'This chat is already being compacted.', refused: true });
  assert.equal(annotateCompactionCatalog({ sessions: [chat] }).sessions[0]!.compaction?.running, true);
  await during;
  assert.equal(annotateCompactionCatalog({ sessions: [chat] }).sessions[0]!.compaction?.running, undefined);
  process.env.FAKE_CLAUDE_MODE = 'failed';
  const refused = await compactChat(chat, 'phone');
  assert.equal(compactedText(chat, refused), 'Context compaction failed: Not enough messages to compact.');
  assert.equal(compactedText(row('c', 'codex'), { ok: true }), 'Codex context compaction completed.');
  assert.deepEqual(await compactChat(row('g', 'grok'), 'phone'), { ok: false, error: 'grok has no compaction GrantTap can run.', refused: true });
});

test('a Claude Code entry holds its chat only while that same process runs', (t) => {
  const dir = configured(t);
  const entry = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value));
  entry('1.json', { pid: 2 ** 31 - 2, sessionId: 'gone' });
  entry('2.json', { pid: process.pid, sessionId: 'reused', procStart: 'Thu Jan  1 00:00:00 1970' });
  entry('3.json', { pid: process.pid, sessionId: 'open' });
  entry('4.json', 'not an entry');
  writeFileSync(join(dir, '5.json'), '{');
  assert.equal(claudeSessionHeld('open', dir), true);
  assert.equal(claudeSessionHeld('gone', dir), false, 'its process has ended');
  assert.equal(claudeSessionHeld('reused', dir), false, 'another process was given the same id');
  assert.equal(claudeSessionHeld('other', dir), false);
  assert.equal(claudeSessionHeld('open', join(dir, 'missing')), false);
});
