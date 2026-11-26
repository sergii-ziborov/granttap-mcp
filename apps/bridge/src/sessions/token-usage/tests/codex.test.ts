import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCodexFile } from '../../scan/codex/parse';
import { assembleCodexScan } from '../../scan/codex/assemble';
import { codexSummaryCache, codexTokenHoursBySession, type CodexCandidate } from '../../scan/codex/shared';
import { HOUR_MS, hourStart, tokenUsageOf, type TokenHour } from '..';

const NOW = Date.now();
const line = (at: number, type: string, payload: unknown) => JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload }) + '\n';
const counted = (at: number, total: number, cached = 0) => line(at, 'event_msg', { type: 'token_count',
  info: { total_token_usage: { total_tokens: total, cached_input_tokens: cached }, last_token_usage: { total_tokens: 1 } } });
const sum = (rows: readonly TokenHour[]) => rows.reduce((total, row) => total + row.tokens, 0);

test('what each token_count adds to the running total counts at its hour, with the turn model', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-codex-token-hours-'));
  const path = join(root, 'rollout.jsonl');
  t.after(() => { codexSummaryCache.delete(path); rmSync(root, { recursive: true, force: true }); });
  const early = NOW - 5 * HOUR_MS, late = NOW - 60_000;
  writeFileSync(path, line(early, 'session_meta', { id: 'codex-token-hours', cwd: '/fixture', model: 'gpt-meta' })
    + line(early, 'turn_context', { model: 'gpt-5.5' })
    + counted(early + 1_000, 1_000, 400)
    + counted(early + 2_000, 1_000, 400)
    + line(late, 'turn_context', { model: 'gpt-5.5-mini' })
    + counted(late, 1_500, 600));
  const first = parseCodexFile(path)!;
  assert.equal(first.session.tokensSession, 900);
  assert.deepEqual(first.tokenHours, [
    { startedAt: hourStart(early + 1_000), model: 'gpt-5.5', tokens: 600 },
    { startedAt: hourStart(late), model: 'gpt-5.5-mini', tokens: 300 },
  ], 'a repeated total adds nothing');
  appendFileSync(path, counted(late + 1, 1_700, 600));
  const grown = parseCodexFile(path)!;
  assert.equal(sum(grown.tokenHours!), grown.session.tokensSession);
  const day = tokenUsageOf([{ agent: 'codex', sessionId: grown.session.sessionId, model: grown.session.model,
    lastActivityAt: grown.session.lastActivityAt, hours: grown.tokenHours! }]).windows[0]!;
  assert.equal(day.tokens, grown.session.tokensSession, 'a chat whose whole life is in the period spent its tokensSession there');
  assert.deepEqual(day.models.map((row) => [row.model, row.tokens]), [['gpt-5.5', 600], ['gpt-5.5-mini', 500]]);
  assert.deepEqual(parseCodexFile(path)!.tokenHours, grown.tokenHours, 'an unchanged rollout answers from the cache');
});

test('a chat\'s forked agents count toward it once each', () => {
  const session = (sessionId: string, tokensSession: number) => ({ sessionId, agent: 'codex' as const, state: 'idle' as const,
    startedAt: NOW - HOUR_MS, lastActivityAt: NOW - 1_000, tokensSession, tokensLastTurn: 0 });
  const at = hourStart(NOW - HOUR_MS);
  const candidates: CodexCandidate[] = [
    { file: '/root.jsonl', session: session('codex-root', 100), observations: [], tokenHours: [{ startedAt: at, model: 'gpt-5.5', tokens: 100 }] },
    { file: '/child.jsonl', session: session('codex-child', 40), observations: [],
      child: { parentThreadId: 'codex-root', depth: 1 }, tokenHours: [{ startedAt: at, model: 'gpt-5.5', tokens: 40 }] },
    { file: '/orphan.jsonl', session: session('codex-orphan', 7), observations: [],
      child: { parentThreadId: 'codex-gone', depth: 1 }, tokenHours: [{ startedAt: at, tokens: 7 }] },
  ];
  const scan = assembleCodexScan(candidates);
  for (const chat of scan.sessions) {
    assert.equal(sum(codexTokenHoursBySession.get(chat.sessionId) ?? []), chat.tokensSession, chat.sessionId);
  }
  assert.deepEqual(codexTokenHoursBySession.get('codex-root'), [{ startedAt: at, model: 'gpt-5.5', tokens: 140 }]);
  assert.deepEqual(codexTokenHoursBySession.get('codex-gone'), [{ startedAt: at, tokens: 7 }]);
  codexTokenHoursBySession.clear();
});
