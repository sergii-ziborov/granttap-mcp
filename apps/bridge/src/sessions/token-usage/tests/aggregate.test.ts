import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addTokenHour, combineTokenHours, createTokenHours, HOUR_MS, hourStart, tokenHourRows, tokenUsageOf,
  type SessionTokenHours, type TokenHour,
} from '..';

const NOW = new Date(2026, 10, 26, 12, 30).getTime();
const hoursAgo = (hours: number) => hourStart(NOW - hours * HOUR_MS);
const chat = (sessionId: string, hours: TokenHour[], extra: Partial<SessionTokenHours> = {}): SessionTokenHours =>
  ({ agent: 'claude', sessionId, lastActivityAt: NOW, hours, ...extra });
const window = (usage: ReturnType<typeof tokenUsageOf>, windowHours: number) =>
  usage.windows.find((row) => row.windowHours === windowHours)!;

test('turns are counted per clock hour and model, and hours past 31 days leave the count', () => {
  const hours = createTokenHours();
  const ten = new Date(2026, 10, 26, 10, 0).getTime();
  addTokenHour(hours, ten + 5 * 60_000, 10, 'opus');
  addTokenHour(hours, ten + 55 * 60_000, 5, 'opus');
  addTokenHour(hours, ten + 61 * 60_000, 7, ' opus ');
  addTokenHour(hours, ten + 62 * 60_000, 3, '<synthetic>');
  addTokenHour(hours, undefined, 4);
  addTokenHour(hours, ten, 0, 'opus');
  addTokenHour(hours, ten - 40 * 24 * HOUR_MS, 9, 'opus');
  assert.deepEqual(tokenHourRows(hours, NOW), [
    { tokens: 4 },
    { startedAt: ten, model: 'opus', tokens: 15 },
    { startedAt: ten + HOUR_MS, model: 'opus', tokens: 7 },
    { startedAt: ten + HOUR_MS, tokens: 3 },
  ]);
  assert.equal(hours.size, 3, 'the old hour is pruned from the running count too');
  assert.deepEqual(combineTokenHours([[{ startedAt: ten, model: 'opus', tokens: 1 }], undefined,
    [{ startedAt: ten, model: 'opus', tokens: 2 }, { tokens: 1 }]], NOW),
  [{ tokens: 1 }, { startedAt: ten, model: 'opus', tokens: 3 }]);
});

test('each period counts the hours since the hour holding now minus the period', () => {
  const usage = tokenUsageOf([chat('a', [
    { startedAt: hoursAgo(0), tokens: 1 },
    { startedAt: hoursAgo(24), tokens: 2 },
    { startedAt: hoursAgo(24) - HOUR_MS, tokens: 4 },
    { startedAt: hoursAgo(72), tokens: 8 },
    { startedAt: hoursAgo(168), tokens: 16 },
    { startedAt: hoursAgo(20 * 24), tokens: 32 },
    { startedAt: hoursAgo(720), tokens: 64 },
    { startedAt: hoursAgo(721), tokens: 128 },
  ])], NOW);
  assert.deepEqual(usage.windows.map((row) => [row.windowHours, row.tokens]), [[24, 3], [168, 31], [720, 127]]);
  assert.deepEqual(usage.hours, [{ startedAt: hoursAgo(24), tokens: 2 }, { startedAt: hoursAgo(0), tokens: 1 }]);
});

test('the last day has at most 25 hours with spend, oldest first, and a future turn counts now', () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({ startedAt: hoursAgo(index), tokens: index + 1 }));
  const usage = tokenUsageOf([chat('a', [...rows, { startedAt: NOW + 5 * HOUR_MS, tokens: 100 }])], NOW);
  assert.equal(usage.hours.length, 25);
  assert.deepEqual(usage.hours[0], { startedAt: hoursAgo(24), tokens: 25 });
  assert.deepEqual(usage.hours.at(-1), { startedAt: hoursAgo(0), tokens: 101 });
  assert.ok(usage.hours.every((hour, index) => index === 0 || hour.startedAt > usage.hours[index - 1]!.startedAt));
});

test('the heaviest 12 chats and 16 models are listed, and the total keeps everything', () => {
  const chats = Array.from({ length: 15 }, (_, index) => chat(`chat-${index}`, [
    { startedAt: hoursAgo(1), model: `model-${index}`, tokens: 100 + index },
    { startedAt: hoursAgo(2), model: `model-${index + 15}`, tokens: 1 },
  ]));
  const day = window(tokenUsageOf(chats, NOW), 24);
  const total = chats.reduce((sum, item) => sum + item.hours.reduce((inner, row) => inner + row.tokens, 0), 0);
  assert.equal(day.tokens, total);
  assert.equal(day.chats.length, 12);
  assert.deepEqual(day.chats.slice(0, 2).map((row) => [row.sessionId, row.tokens]), [['chat-14', 115], ['chat-13', 114]]);
  assert.equal(day.models.length, 16);
  assert.deepEqual(day.models[0], { agent: 'claude', model: 'model-14', tokens: 114 });
});

test('a turn names its own model, or the chat\'s, or counts only toward totals and chats', () => {
  const usage = tokenUsageOf([
    chat('named', [{ startedAt: hoursAgo(1), model: 'opus', tokens: 10 }, { startedAt: hoursAgo(1), tokens: 5 }],
      { model: 'sonnet' }),
    chat('nameless', [{ startedAt: hoursAgo(1), tokens: 7 }]),
    chat('codex-chat', [{ startedAt: hoursAgo(1), model: 'opus', tokens: 1 }], { agent: 'codex' }),
  ], NOW);
  const day = window(usage, 24);
  assert.equal(day.tokens, 23);
  assert.deepEqual(day.models, [
    { agent: 'claude', model: 'opus', tokens: 10 },
    { agent: 'claude', model: 'sonnet', tokens: 5 },
    { agent: 'codex', model: 'opus', tokens: 1 },
  ]);
  assert.deepEqual(day.chats, [
    { sessionId: 'named', agent: 'claude', model: 'sonnet', tokens: 15 },
    { sessionId: 'nameless', agent: 'claude', tokens: 7 },
    { sessionId: 'codex-chat', agent: 'codex', model: 'opus', tokens: 1 },
  ]);
});

test('a chat with nothing in a period is not listed there, and an undated turn counts at its last activity', () => {
  const usage = tokenUsageOf([
    chat('old', [{ startedAt: hoursAgo(100), tokens: 50 }]),
    chat('undated', [{ tokens: 9 }], { lastActivityAt: NOW - 3 * HOUR_MS }),
    chat('empty', []),
    chat('x'.repeat(257), [{ startedAt: hoursAgo(1), tokens: 1 }]),
  ], NOW);
  assert.deepEqual(window(usage, 24).chats.map((row) => row.sessionId), ['undated']);
  assert.equal(window(usage, 24).tokens, 10, 'a chat the wire cannot name still counts in the total');
  assert.deepEqual(window(usage, 168).chats.map((row) => row.sessionId), ['old', 'undated']);
  assert.deepEqual(usage.hours, [{ startedAt: hoursAgo(3), tokens: 9 }, { startedAt: hoursAgo(1), tokens: 1 }]);
  assert.deepEqual(tokenUsageOf([], NOW), { windows: [24, 168, 720].map((windowHours) =>
    ({ windowHours, tokens: 0, chats: [], models: [] })), hours: [] });
});
