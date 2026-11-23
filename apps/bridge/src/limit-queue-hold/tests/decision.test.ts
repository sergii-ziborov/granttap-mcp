import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderAccountUsage, SessionInfo } from '../../../../../packages/protocol/schema';
import { CONTINUATION_FIRST_MS, RETRY_AFTER_REFUSAL_MS, chatLimit, queueDecision, type DecisionInput } from '../decision';
import { readingsShowRoom } from '../readings';

const minute = 60_000, hour = 60 * minute, NOW = Date.UTC(2026, 10, 23, 10, 0), RESET = NOW + 3 * hour;
const chat = (extra: Partial<SessionInfo> = {}): SessionInfo => ({ sessionId: 'decision-chat', agent: 'claude', state: 'idle',
  startedAt: NOW - 5 * hour, lastActivityAt: NOW - minute, tokensSession: 0, tokensLastTurn: 0,
  usageLimit: { resetsAt: RESET, window: 'five_hour' }, ...extra });
const decide = (input: Partial<DecisionInput> = {}) => queueDecision({ session: chat(), now: NOW, ahead: {},
  room: () => false, ...input });
const hold = (decision: ReturnType<typeof decide>) => 'hold' in decision ? [decision.hold, decision.until] : decision.release;

test('a chat without a limit holds nothing; a rate limit is not a usage limit', () => {
  const { usageLimit: _limit, ...free } = chat();
  assert.equal(hold(decide({ session: free })), 'went-on');
  assert.equal(chatLimit({ ...free, stopped: { reason: 'rate_limit', at: NOW } }), undefined);
  assert.deepEqual(chatLimit(chat({ stopped: { reason: 'usage_limit', at: NOW - 5_000 } })),
    { resetsAt: RESET, window: 'five_hour', refusedAt: NOW - 5_000 });
});

test('before the reset the queue waits for it, unless a reading shows room and no continuation waits', () => {
  assert.deepEqual(hold(decide()), ['reset', RESET]);
  const since: number[] = [];
  assert.equal(hold(decide({ room: (_limit, at) => { since.push(at); return true; } })), 'readings');
  assert.deepEqual(since, [NOW - minute], 'only a reading taken after the refusal speaks for it');
  const ahead = { resetsAt: RESET, dueAt: RESET + minute };
  assert.deepEqual(hold(decide({ ahead, room: () => true })), ['reset', RESET],
    'the continuation, and its own early copy, go first');
  assert.deepEqual(hold(decide({ now: RESET + 30_000 })), ['reset', RESET], 'a minute of grace after the stated reset');
  assert.equal(hold(decide({ now: RESET + minute })), 'reset');
});

test('after the reset the continuation goes first, for ten minutes past its time at most', () => {
  const ahead = { resetsAt: RESET, dueAt: RESET + minute };
  assert.deepEqual(hold(decide({ ahead, now: RESET + minute })), ['continuation', RESET + minute]);
  assert.equal(hold(decide({ ahead, now: RESET + minute + CONTINUATION_FIRST_MS })), 'late-continuation');
  assert.equal(hold(decide({ ahead: { resetsAt: NOW, dueAt: NOW }, now: RESET + minute })), 'reset',
    "another limit's continuation is not this one's");
  assert.equal(hold(decide({ ahead: { resetsAt: RESET, deliveredAt: RESET + minute }, now: RESET + 2 * minute })), 'continued');
  assert.equal(hold(decide({ triedAt: RESET + minute, now: RESET + 2 * minute })), 'trying',
    'one went since the refusal; its run decides');
});

test('refused again after a try, the chat waits a quarter of an hour, or for a later reset; readings do not shorten it', () => {
  const refusedAt = RESET + 2 * minute, session = chat({ lastActivityAt: refusedAt });
  const again = (now: number, extra: Partial<DecisionInput> = {}) =>
    hold(decide({ session, triedAt: RESET + minute, now, room: () => true, ...extra }));
  assert.deepEqual(again(refusedAt + minute), ['refused-again', refusedAt + RETRY_AFTER_REFUSAL_MS]);
  assert.equal(again(refusedAt + RETRY_AFTER_REFUSAL_MS), 'retry');
  assert.deepEqual(again(refusedAt + minute, { triedAt: undefined, ahead: { deliveredAt: RESET + minute } }),
    ['refused-again', refusedAt + RETRY_AFTER_REFUSAL_MS], 'the continuation was the try');
  const weekly = chat({ lastActivityAt: refusedAt, usageLimit: { resetsAt: RESET + 48 * hour, window: 'seven_day' } });
  assert.deepEqual(hold(decide({ session: weekly, triedAt: RESET + minute, now: refusedAt + hour })),
    ['refused-again', RESET + 48 * hour]);
  assert.equal(hold(decide({ session: weekly, triedAt: RESET + minute, now: RESET + 48 * hour + minute })), 'reset');
  assert.deepEqual(again(refusedAt + minute, { ahead: { resetsAt: RESET, dueAt: refusedAt + minute } }),
    ['continuation', refusedAt + minute], 'the next continuation still goes first');
});

test('a limit with no known reset waits for a reading that shows room, or a quarter of an hour', () => {
  const { usageLimit: _limit, ...rest } = chat();
  const codex: SessionInfo = { ...rest, agent: 'codex', stopped: { reason: 'usage_limit', at: NOW - minute } };
  assert.deepEqual(hold(decide({ session: codex })), ['unknown-reset', NOW - minute + RETRY_AFTER_REFUSAL_MS]);
  assert.equal(hold(decide({ session: codex, room: () => true })), 'readings');
  assert.equal(hold(decide({ session: codex, now: NOW - minute + RETRY_AFTER_REFUSAL_MS })), 'retry');
});

test('readings show room only when taken after the refusal, recently, and below 98 % of the window that refused', () => {
  const claude = (usedPercent: number, observedAt = NOW): ProviderAccountUsage => ({ provider: 'claude', limitId: 'claude',
    observedAt, windows: [{ id: 'primary', usedPercent, windowMinutes: 300, resetsAt: RESET }] });
  const limit = { resetsAt: RESET, window: 'five_hour', refusedAt: NOW - minute };
  assert.equal(readingsShowRoom('claude', limit, NOW - minute, [claude(40)], NOW), true);
  assert.equal(readingsShowRoom('claude', limit, NOW - minute, [claude(99)], NOW), false);
  assert.equal(readingsShowRoom('claude', limit, NOW - minute, [claude(40, NOW - 2 * minute)], NOW), false);
  const codex = (percents: number[], observedAt = NOW): ProviderAccountUsage => ({ provider: 'codex', limitId: 'codex',
    observedAt, windows: percents.map((usedPercent, index) => ({ id: index ? 'secondary' : 'primary', usedPercent,
      windowMinutes: 300, resetsAt: RESET })) });
  const unknown = { refusedAt: NOW - minute };
  assert.equal(readingsShowRoom('codex', unknown, NOW - minute, [codex([20, 60])], NOW), true);
  assert.equal(readingsShowRoom('codex', unknown, NOW - minute, [codex([20, 99])], NOW), false);
  assert.equal(readingsShowRoom('codex', unknown, NOW - minute, [codex([])], NOW), false, 'a signed-out account shows nothing');
  assert.equal(readingsShowRoom('codex', unknown, NOW - 20 * minute, [codex([10], NOW - 11 * minute)], NOW), false,
    'a reading over ten minutes old says nothing about now');
  assert.equal(readingsShowRoom('claude', { resetsAt: RESET, refusedAt: NOW - minute }, NOW - minute, [claude(40)], NOW), true,
    'a Claude limit that names no window is read from the account');
});
