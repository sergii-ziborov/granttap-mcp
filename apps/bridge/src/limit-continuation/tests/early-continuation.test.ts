import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import type {ProviderAccountUsage, SessionInfo, UserMessage} from '../../../../../packages/protocol/schema';
import {
  LIMIT_CONTINUE_GRACE_MS, LIMIT_ROOM_PROMPT, limitContinuationUnwanted, scheduleLimitContinuations, setAutoContinue,
  type ContinuationQueue,
} from '..';
import {limitLifted} from '../lift';

const minute = 60_000;
// Chat 80a46137 was refused by its weekly window at 01:13Z on Nov 15 with a reset at Nov 16 11:00Z.
const refusedAt = Date.parse('2026-11-15T01:13:45Z'), weeklyReset = 1_794_826_800_000;
function isolated(t: {after: (fn: () => void) => void}): string {
  const root = mkdtempSync(join(tmpdir(), 'granttap-limit-early-')), prior = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => { if (prior === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = prior;
    rmSync(root, {recursive: true, force: true}); });
  return root;
}
function queue(): ContinuationQueue & {submitted: {message: UserMessage; notBefore: number}[]; cancelled: string[]} {
  const submitted: {message: UserMessage; notBefore: number}[] = [], cancelled: string[] = [];
  return {submitted, cancelled,
    submit: async (_scope, message, notBefore) => { submitted.push({message, notBefore}); },
    cancel: async (_scope, id) => { cancelled.push(id); }};
}
const chat = (window: string | undefined, resetsAt = weeklyReset, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: 'limited-chat', agent: 'claude', cwd: '/work/app', state: 'idle', startedAt: refusedAt - 3_600_000,
  lastActivityAt: refusedAt, tokensSession: 0, tokensLastTurn: 0,
  usageLimit: {resetsAt, ...(window ? {window} : {})}, ...extra});
const going = (): SessionInfo => ({...chat('seven_day'), state: 'working', usageLimit: undefined});
const account = (observedAt: number, windows: {id: 'primary' | 'secondary'; usedPercent: number; resetsAt: number}[])
  : ProviderAccountUsage => ({provider: 'claude', limitId: 'claude', observedAt,
  windows: windows.map(window => ({...window, windowMinutes: window.id === 'primary' ? 300 : 10_080}))});
const weekly = (observedAt: number, usedPercent: number, resetsAt = weeklyReset) =>
  account(observedAt, [{id: 'secondary', usedPercent, resetsAt}]);
const model = (slug: string, label: string, observedAt: number, usedPercent: number): ProviderAccountUsage => ({
  provider: 'claude', limitId: `claude:model:${slug}`, label, observedAt,
  windows: [{id: 'secondary', usedPercent, windowMinutes: 10_080, resetsAt: weeklyReset}]});
const ids = (relay: ReturnType<typeof queue>) => relay.submitted.map(row => row.message.messageId);

test('a weekly window that has room again continues the chat at once, besides the continuation at the reset', async t => {
  isolated(t);
  const relay = queue();
  await scheduleLimitContinuations([chat('seven_day')], relay, refusedAt, () => [weekly(refusedAt - minute, 72)]);
  assert.equal(relay.submitted.length, 1, 'a reading taken before the continuation was queued says nothing');
  await scheduleLimitContinuations([chat('seven_day')], relay, refusedAt + minute, () => [weekly(refusedAt - minute, 72)]);
  assert.equal(relay.submitted.length, 1, 'not even a moment later');
  const [regular] = relay.submitted;
  const at = Date.parse('2026-11-15T05:19:00Z');
  await scheduleLimitContinuations([chat('seven_day')], relay, at, () => [weekly(at - 30_000, 72)]);
  assert.equal(relay.submitted.length, 2);
  const early = relay.submitted[1]!;
  assert.equal(early.notBefore, at, 'due at once');
  assert.equal(early.message.text, LIMIT_ROOM_PROMPT);
  assert.equal(early.message.cwd, '/work/app');
  assert.notEqual(early.message.messageId, regular!.message.messageId);
  assert.match(early.message.messageId ?? '', /^limit-continue-early-/);
  assert.equal(regular!.notBefore, weeklyReset + LIMIT_CONTINUE_GRACE_MS);
  assert.deepEqual(relay.cancelled, [], 'the continuation at the reset stays queued');
  assert.equal(limitContinuationUnwanted(early.message), false, 'the early one is delivered');
  assert.equal(limitContinuationUnwanted(regular!.message), false);

  await scheduleLimitContinuations([chat('seven_day')], relay, at + minute, () => [weekly(at + 30_000, 50)]);
  assert.equal(relay.submitted.length, 2, 'one early try per limit');
  assert.deepEqual(relay.cancelled, [], 'a chat refused again for the same reset keeps the continuation at the reset');
});

test('a five-hour window that already rolled over continues the chat early', async t => {
  isolated(t);
  const relay = queue(), resetsAt = refusedAt + 3 * 3_600_000, later = refusedAt + 10 * minute;
  await scheduleLimitContinuations([chat('five_hour', resetsAt)], relay, refusedAt);
  await scheduleLimitContinuations([chat('five_hour', resetsAt)], relay, later,
    () => [account(later - minute, [{id: 'primary', usedPercent: 100, resetsAt: resetsAt - 2 * 3_600_000}])]);
  assert.equal(relay.submitted.length, 2);
  assert.match(relay.submitted[1]!.message.messageId ?? '', /^limit-continue-early-/);
});

test('a window is not lifted early without a fresh, signed-in reading of that same window with room', () => {
  const scheduledAt = refusedAt, now = refusedAt + 30 * minute, fresh = now - minute;
  const lifted = (window: string | undefined, usage: ProviderAccountUsage[], resetsAt = weeklyReset, at = scheduledAt) =>
    limitLifted({resetsAt, ...(window ? {window} : {})}, at, usage, now);
  assert.equal(lifted('seven_day', [weekly(fresh, 97.9)]), true);
  assert.equal(lifted('seven_day', [weekly(fresh, 98)]), false, 'nearly full is full');
  assert.equal(lifted('seven_day', [weekly(fresh, 100, weeklyReset - 2 * minute)]), false, 'the same reset, rounded');
  assert.equal(lifted('seven_day', [weekly(now - 11 * minute, 10)]), false, 'a stale reading');
  assert.equal(lifted('seven_day', [weekly(fresh, 10)], weeklyReset, fresh + 1), false, 'a reading older than the job');
  assert.equal(lifted('seven_day', [weekly(fresh, 10)], weeklyReset, fresh), false);
  assert.equal(lifted('seven_day', [account(fresh, [{id: 'primary', usedPercent: 10, resetsAt: now + minute}])]), false,
    'the other window');
  assert.equal(lifted('five_hour', [weekly(fresh, 10)]), false);
  assert.equal(lifted('seven_day_overage_included', [weekly(fresh, 10), model('fable', 'Fable', fresh, 10)]), false);
  assert.equal(lifted('seven_day_overage', [weekly(fresh, 10), model('overage', 'Overage', fresh, 10)]), false);
  assert.equal(lifted('something_new', [weekly(fresh, 10)]), false, 'an unknown kind');
  assert.equal(lifted(undefined, [weekly(fresh, 10)]), false);
  assert.equal(lifted('seven_day', []), false, 'no reading');
  assert.equal(lifted('seven_day', [{...weekly(fresh, 10), provider: 'cursor', limitId: 'cursor'}]), false);
  const signedOut: ProviderAccountUsage = {provider: 'claude', limitId: 'claude:signed-out', observedAt: fresh, windows: []};
  assert.equal(lifted('seven_day', [signedOut, weekly(fresh, 10)]), false, 'signed out');
  assert.equal(lifted('seven_day', [model('fable', 'Fable', fresh, 10)]), false, 'a model limit is not the account');
});

test('a weekly limit named after one model is read from that model\'s limit when only one reading names it', () => {
  const now = refusedAt + 30 * minute, fresh = now - minute;
  const lifted = (window: string, usage: ProviderAccountUsage[]) => limitLifted({resetsAt: weeklyReset, window}, refusedAt, usage, now);
  assert.equal(lifted('seven_day_fable', [weekly(fresh, 100), model('fable', 'Fable', fresh, 40)]), true);
  assert.equal(lifted('seven_day_fable', [weekly(fresh, 10), model('fable', 'Fable', fresh, 99)]), false);
  assert.equal(lifted('seven_day_opus', [model('opus-5.5', 'Opus 5.5', fresh, 40)]), true);
  assert.equal(lifted('seven_day_opus', [model('opus-5.5', 'Opus 5.5', fresh, 40), model('opus-5', 'Opus 5', fresh, 40)]),
    false, 'two readings could be the one');
  assert.equal(lifted('seven_day_opus', [weekly(fresh, 10), model('fable', 'Fable', fresh, 10)]), false);
  assert.equal(lifted('seven_day_opus', [model('opusx', 'Opusx', fresh, 10)]), false);
});

test('a chat refused again for the same reset after an early try is not tried early again', async t => {
  isolated(t);
  const relay = queue(), at = refusedAt + 20 * minute, reading = () => [weekly(at - minute, 30)];
  await scheduleLimitContinuations([chat('seven_day')], relay, refusedAt, reading);
  await scheduleLimitContinuations([chat('seven_day')], relay, at, reading);
  const [regular, early] = ids(relay);
  await scheduleLimitContinuations([going()], relay, at + 10_000, reading);
  assert.deepEqual(relay.cancelled, [regular, early], 'the chat went on: both are taken back');
  await scheduleLimitContinuations([chat('seven_day')], relay, at + 20_000, () => [weekly(at + 15_000, 30)]);
  await scheduleLimitContinuations([chat('seven_day')], relay, at + minute, () => [weekly(at + 50_000, 30)]);
  assert.equal(relay.submitted.length, 3, 'the continuation at the reset is queued again, not the early one');
  const again = ids(relay)[2]!;
  assert.match(again, /^limit-continue-(?!early-)/);
  assert.notEqual(again, regular, 'under a new id: the relay keeps the one it cancelled and refuses it for another message');
  assert.equal(relay.submitted[2]!.notBefore, weeklyReset + LIMIT_CONTINUE_GRACE_MS);
  assert.equal(limitContinuationUnwanted(relay.submitted[1]!.message), true, 'a copy of the early one is not delivered');
  assert.equal(limitContinuationUnwanted(relay.submitted[0]!.message), true, 'nor the first one at the reset');
  assert.equal(limitContinuationUnwanted(relay.submitted[2]!.message), false);
});

test('turning a chat off takes back both continuations and refuses either at delivery', async t => {
  isolated(t);
  const relay = queue(), at = refusedAt + 20 * minute;
  await scheduleLimitContinuations([chat('seven_day')], relay, refusedAt);
  await scheduleLimitContinuations([chat('seven_day')], relay, at, () => [weekly(at - minute, 30)]);
  setAutoContinue('limited-chat', false);
  await scheduleLimitContinuations([chat('seven_day')], relay, at + 10_000, () => [weekly(at, 30)]);
  assert.deepEqual(relay.cancelled, ids(relay));
  assert.equal(relay.submitted.length, 2);
  for (const {message} of relay.submitted) assert.equal(limitContinuationUnwanted(message), true);
});

test('readings are asked only while a continuation could still go early, and never past the reset', async t => {
  isolated(t);
  const relay = queue(), resetsAt = refusedAt + 10 * minute;
  let asked = 0;
  const reading = () => { asked++; return [weekly(resetsAt - 30_000, 10, resetsAt)]; };
  await scheduleLimitContinuations([chat(undefined, resetsAt, {usageLimit: undefined})], relay, refusedAt, reading);
  await scheduleLimitContinuations([chat('seven_day', resetsAt)], relay, refusedAt, reading);
  assert.equal(asked, 0, 'nothing waits, or the job was queued this very moment');
  await scheduleLimitContinuations([chat('seven_day', resetsAt)], relay, resetsAt, reading);
  assert.equal(asked, 0);
  assert.equal(relay.submitted.length, 1, 'at the reset the regular continuation is due anyway');
  const other = chat('five_hour', resetsAt + minute, {sessionId: 'other-chat'});
  const third = chat('five_hour', resetsAt + minute, {sessionId: 'third-chat'});
  await scheduleLimitContinuations([other], relay, refusedAt);
  await scheduleLimitContinuations([other, third], relay, refusedAt + minute, () => { throw new Error('unreadable'); });
  await scheduleLimitContinuations([other, third], relay, refusedAt + 2 * minute);
  assert.equal(relay.submitted.length, 3, 'unreadable limits only mean nothing goes early; what was queued is recorded');
});

test('a continuation queued before its time was recorded counts from the first look after the update', async t => {
  const root = isolated(t);
  const relay = queue(), file = join(root, 'limit-continuation.json');
  const scope = {sessionId: 'limited-chat', provider: 'claude' as const};
  writeFileSync(file, JSON.stringify({off: ['other-chat'], scheduled: {'limited-chat': {resetsAt: weeklyReset,
    messageId: 'limit-continue-legacy', scope}}}));
  const at = refusedAt + 30 * minute;
  await scheduleLimitContinuations([chat('seven_day')], relay, at, () => [weekly(at - minute, 10)]);
  assert.equal(relay.submitted.length, 0, 'the old file loads and its job stays; an older reading does not count');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).scheduled['limited-chat'].scheduledAt, at);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).off, ['other-chat']);
  await scheduleLimitContinuations([chat('seven_day')], relay, at + minute, () => [weekly(at + 30_000, 10)]);
  assert.equal(relay.submitted.length, 1);
  assert.match(relay.submitted[0]!.message.messageId ?? '', /^limit-continue-early-/);
  const legacy = {type: 'user.message', messageId: 'limit-continue-legacy', sessionId: 'limited-chat', text: 'x',
    createdAt: at} as UserMessage;
  assert.equal(limitContinuationUnwanted(legacy), false);
});

test('an early continuation is wanted as soon as the relay has it, and one the relay refused is tried again', async t => {
  isolated(t);
  const relay = queue(), at = refusedAt + 20 * minute, wantedOnArrival: boolean[] = [], tried: string[] = [];
  let refuse = true;
  const flaky: ContinuationQueue = {cancel: relay.cancel, submit: async (scope, message, notBefore, createdAt) => {
    const early = message.messageId?.includes('early');
    if (early) tried.push(`${message.messageId}:${notBefore}:${createdAt}`);
    if (early && refuse) { refuse = false; throw new Error('relay unavailable'); }
    if (early) wantedOnArrival.push(!limitContinuationUnwanted(message));
    return relay.submit(scope, message, notBefore, createdAt);
  }};
  await scheduleLimitContinuations([chat('seven_day')], flaky, refusedAt);
  await scheduleLimitContinuations([chat('seven_day')], flaky, at, () => [weekly(at - minute, 30)]);
  assert.equal(relay.submitted.length, 1, 'a relay that refused it does not stop the monitor');
  await scheduleLimitContinuations([chat('seven_day')], flaky, at + minute, () => [weekly(at, 30)]);
  assert.equal(relay.submitted.length, 2);
  assert.equal(tried.length, 2);
  assert.equal(tried[0], tried[1], 'the same copy is sent again, so the relay can never hold two');
  assert.deepEqual(wantedOnArrival, [true], 'delivery that comes back at once already finds it wanted');
});

test('an early try is forgotten an hour after its reset', async t => {
  const root = isolated(t);
  const relay = queue(), resetsAt = refusedAt + 30 * minute, at = refusedAt + 10 * minute;
  const file = join(root, 'limit-continuation.json');
  await scheduleLimitContinuations([chat('seven_day', resetsAt)], relay, refusedAt);
  await scheduleLimitContinuations([chat('seven_day', resetsAt)], relay, at, () => [weekly(at - minute, 10, resetsAt)]);
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).tried['limited-chat']);
  await scheduleLimitContinuations([], relay, resetsAt + 2 * 3_600_000);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).tried, undefined);
});
