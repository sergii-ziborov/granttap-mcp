import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { grokTokenHours, scanGrok } from '../grok';
import { HOUR_MS, hourStart, tokenUsageOf } from '../../token-usage';

test('Grok counts its estimated tokens at each turn\'s time, and at the last activity without one', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-grok-token-hours-'));
  const directory = join(root, 'project', 'grok-tokens');
  mkdirSync(directory, { recursive: true });
  const previous = process.env.GRANTTAP_GROK_SESSIONS_DIR;
  process.env.GRANTTAP_GROK_SESSIONS_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_GROK_SESSIONS_DIR;
    else process.env.GRANTTAP_GROK_SESSIONS_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const now = Date.now(), asked = now - 4 * HOUR_MS;
  writeFileSync(join(directory, 'summary.json'), JSON.stringify({ info: { id: 'grok-tokens' }, current_model_id: 'grok-code',
    created_at: new Date(asked).toISOString(), updated_at: new Date(now).toISOString() }));
  writeFileSync(join(directory, 'chat_history.jsonl'), [
    { role: 'assistant', content: 'A greeting the history gave no time, before any prompt' },
    { role: 'user', timestamp: new Date(asked).toISOString(), content: 'A synthetic request about the build' },
    { role: 'assistant', timestamp: new Date(asked + 1_000).toISOString(), content: 'A synthetic answer about the build' },
  ].map(row => JSON.stringify(row)).join('\n'));
  const session = scanGrok().sessions.find(item => item.sessionId === 'grok-tokens')!;
  const hours = grokTokenHours('grok-tokens');
  assert.equal(hours.reduce((sum, row) => sum + row.tokens, 0), session.tokensSession);
  assert.ok(hours.some(row => row.startedAt === hourStart(asked)));
  assert.ok(hours.some(row => row.startedAt == null), 'a row without its own time waits for the chat\'s last activity');
  assert.ok(hours.every(row => row.model == null), 'Grok names no model per turn');
  const usage = tokenUsageOf([{ agent: 'grok', sessionId: session.sessionId, model: session.model,
    lastActivityAt: session.lastActivityAt, hours }]);
  assert.equal(usage.windows[0]!.tokens, session.tokensSession);
  assert.deepEqual(usage.windows[0]!.models, [{ agent: 'grok', model: 'grok-code', tokens: session.tokensSession }]);
  assert.deepEqual(grokTokenHours('unknown'), []);
});
