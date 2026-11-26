import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseClaudeFile } from '../../scan/claude/parse';
import { claudeLogPathBySession, claudeSummaryCache, claudeTokenHours } from '../../scan/claude/shared';
import { addTokenHour, createTokenHours, HOUR_MS, tokenHourRows, tokenUsageOf, type TokenHour } from '..';

const SESSION = 'c0000000-0000-4000-8000-0000000000aa';
const NOW = Date.now();
type Turn = { at: number; model?: string; usage: Record<string, number>; agentId?: string };
const asked = (at: number) => JSON.stringify({ type: 'user', sessionId: SESSION, cwd: '/fixture', timestamp: new Date(at).toISOString(),
  message: { role: 'user', content: 'Synthetic question' } });
const answered = ({ at, model, usage, agentId }: Turn) => JSON.stringify({ type: 'assistant', sessionId: SESSION,
  timestamp: new Date(at).toISOString(), ...(agentId ? { agentId, isSidechain: true } : {}),
  message: { role: 'assistant', ...(model ? { model } : {}), stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'Synthetic answer' }], usage } });
const lines = (rows: string[]) => rows.join('\n') + '\n';
const sum = (rows: readonly TokenHour[]) => rows.reduce((total, row) => total + row.tokens, 0);

/** What the reader should count: `sumClaudeUsage` of each turn, at its hour, with its own model. */
function expected(turns: Turn[]): TokenHour[] {
  const hours = createTokenHours();
  for (const { at, model, usage } of turns) {
    addTokenHour(hours, at, (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0), model);
  }
  return tokenHourRows(hours);
}

function fixture(t: { after: (run: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-claude-token-hours-'));
  const file = join(root, `${SESSION}.jsonl`);
  t.after(() => {
    claudeSummaryCache.delete(file);
    claudeLogPathBySession.delete(SESSION);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, file };
}

test('a chat counts each turn at its hour and model, its subagents included, and adds up to tokensSession', t => {
  const { root, file } = fixture(t);
  const own: Turn[] = [
    { at: NOW - 3 * HOUR_MS, model: 'claude-opus-5-5',
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 9_000 } },
    { at: NOW - 1.5 * HOUR_MS, model: 'claude-fable-5-2', usage: { input_tokens: 20, output_tokens: 7 } },
    { at: NOW - 60_000, model: '<synthetic>', usage: { input_tokens: 3, output_tokens: 0 } },
  ];
  writeFileSync(file, lines([asked(NOW - 3 * HOUR_MS - 1_000), ...own.map(answered)]));
  const child: Turn = { at: NOW - 2 * HOUR_MS, model: 'claude-haiku-5-5', usage: { input_tokens: 30, output_tokens: 1 }, agentId: 'helper' };
  mkdirSync(join(root, SESSION, 'subagents'), { recursive: true });
  writeFileSync(join(root, SESSION, 'subagents', 'agent-helper.jsonl'), lines([answered(child)]));

  const parsed = parseClaudeFile(file)!;
  claudeLogPathBySession.set(SESSION, file);
  const hours = claudeTokenHours(SESSION);
  assert.equal(parsed.session.tokensSession, 115 + 27 + 3 + 31);
  assert.equal(sum(hours), parsed.session.tokensSession, 'cache reads are left out, as tokensSession leaves them out');
  assert.deepEqual(hours, expected([...own, child]));
  const usage = tokenUsageOf([{ agent: 'claude', sessionId: SESSION, model: parsed.session.model,
    lastActivityAt: parsed.session.lastActivityAt, hours }]);
  const day = usage.windows.find((row) => row.windowHours === 24)!;
  assert.equal(day.tokens, parsed.session.tokensSession, 'a chat whose whole life is in the period spent its tokensSession there');
  assert.deepEqual(day.chats, [{ sessionId: SESSION, agent: 'claude', model: 'claude-fable-5-2', tokens: 176 }]);
  assert.deepEqual(Object.fromEntries(day.models.map((row) => [row.model, row.tokens])),
    { 'claude-opus-5-5': 115, 'claude-fable-5-2': 30, 'claude-haiku-5-5': 31 }, 'the placeholder model counts as the chat\'s');
  assert.deepEqual(claudeTokenHours('another-chat'), []);
});

test('an appended transcript keeps counting from where it was read, never twice', t => {
  const { file } = fixture(t);
  const first: Turn[] = [{ at: NOW - 2 * HOUR_MS, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5 } },
    { at: NOW - 30_000, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 } }];
  writeFileSync(file, lines([asked(NOW - 2 * HOUR_MS - 1_000), ...first.map(answered)]));
  parseClaudeFile(file);
  assert.ok(claudeSummaryCache.get(file)?.progress, 'a live chat keeps its read progress');
  const later: Turn[] = [{ at: NOW - 10_000, model: 'claude-fable-5-2', usage: { input_tokens: 40, output_tokens: 2 } },
    { at: NOW - 5_000, model: 'claude-fable-5-2', usage: { input_tokens: 8, output_tokens: 0 } }];
  appendFileSync(file, lines([asked(NOW - 20_000), ...later.map(answered)]));
  const grown = parseClaudeFile(file)!;
  const incremental = claudeSummaryCache.get(file)!.tokenHours!;
  assert.equal(sum(incremental), grown.session.tokensSession);
  assert.deepEqual(incremental, expected([...first, ...later]));
  appendFileSync(file, lines([answered({ at: NOW - 1_000, usage: { input_tokens: 4, output_tokens: 4 } })]));
  const again = parseClaudeFile(file)!;
  assert.equal(sum(claudeSummaryCache.get(file)!.tokenHours!), again.session.tokensSession);
  const grownHours = claudeSummaryCache.get(file)!.tokenHours!;
  claudeSummaryCache.delete(file);
  parseClaudeFile(file);
  assert.deepEqual(claudeSummaryCache.get(file)!.tokenHours, grownHours, 'the same as reading the whole transcript');
});
