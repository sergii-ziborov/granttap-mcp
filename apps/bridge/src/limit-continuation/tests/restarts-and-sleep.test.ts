import assert from 'node:assert/strict';
import test from 'node:test';
import type {ProviderAccountUsage, SessionInfo, UserMessage} from '../../../../../packages/protocol/schema';
import {LIMIT_CONTINUE_PROMPT, LIMIT_ROOM_PROMPT, scheduleLimitContinuations, setAutoContinue, type ContinuationQueue} from '..';
import {day, fakeRelay, goingChat, hour, isolatedComputer, limitedChat, machineConfig, minute, monitorProcess,
  offerDue} from './relay-fixture';

const reset = Math.ceil((Date.now() + 5 * day) / hour) * hour, refusal = reset - (4 * day + 10 * hour + 28 * minute);
/** As the monitor runs it after each catalog: a failure is not its caller's to handle. */
const publish = (sessions: SessionInfo[], queue: ContinuationQueue, now: number, readings?: () => ProviderAccountUsage[]) =>
  scheduleLimitContinuations(sessions, queue, now, readings).catch(() => {});
function computer(t: {after: (fn: () => void) => void}) {
  const {senderRoot} = isolatedComputer(t), relay = fakeRelay(), config = machineConfig(), sent = new Map<string, UserMessage>();
  return {relay, sent, start: () => monitorProcess(senderRoot, config, relay, sent)};
}

test('a continuation the relay could not take before an update takeover reaches it from the next monitor', async t => {
  const {relay, sent, start} = computer(t), chat = limitedChat('weekly-chat', reset, refusal);
  const old = start();
  relay.reachable(false);
  await publish([chat], old, refusal + 30_000);
  await old.retryPending().catch(() => {});
  // The update takes over; the relay answers again.
  relay.reachable(true);
  const monitor = start();
  await publish([chat], monitor, refusal + 2 * minute);
  await monitor.retryPending();
  await publish([chat], monitor, refusal + 3 * minute);
  await publish([chat], monitor, reset - 2 * hour);
  assert.equal(relay.queued().length, 1, 'one continuation on the relay, not one per monitor');
  assert.deepEqual(offerDue(relay, sent, reset + 61_000), [LIMIT_CONTINUE_PROMPT]);
});

test('a Mac asleep across the reset continues the chat soon after it wakes', async t => {
  const {relay, sent, start} = computer(t), chat = limitedChat('sleeping-chat', reset, refusal);
  const monitor = start();
  await publish([chat], monitor, refusal + 30_000);
  // Asleep from an hour after the refusal until three hours after the reset. Claude's catalog no longer shows a
  // limit that reset over an hour ago; the chat itself has not moved.
  const woke = reset + 3 * hour, waking = goingChat(chat, refusal, 'idle');
  await publish([waking], monitor, woke);
  await publish([waking], monitor, woke + 30_000);
  assert.deepEqual(offerDue(relay, sent, woke + 31_000), [LIMIT_CONTINUE_PROMPT]);
});

test('a chat the person picked up after the Mac woke is not continued as well', async t => {
  const {relay, sent, start} = computer(t), chat = limitedChat('picked-up-chat', reset, refusal);
  const monitor = start();
  await publish([chat], monitor, refusal + 30_000);
  await publish([goingChat(chat, reset + 3 * hour + 10_000, 'idle')], monitor, reset + 3 * hour + 20_000);
  assert.deepEqual(relay.queued(), []);
  assert.deepEqual(offerDue(relay, sent, reset + 4 * hour), []);
});

test('a copy the relay no longer holds is put on it again, once, by the monitor that finds it gone', async t => {
  const {relay, sent, start} = computer(t), chat = limitedChat('lost-chat', reset, refusal);
  await publish([chat], start(), refusal + 30_000);
  const [lost] = relay.queued();
  relay.jobs.delete(lost!);
  const monitor = start();
  await publish([chat], monitor, refusal + day);
  await publish([chat], monitor, refusal + day + 30_000);
  assert.equal(relay.queued().length, 1);
  assert.notEqual(relay.queued()[0], lost, 'under a new id: the relay keeps an id it has seen');
  assert.deepEqual(offerDue(relay, sent, reset + 61_000), [LIMIT_CONTINUE_PROMPT]);
});

test('the phone turning it off takes it back, even a copy the relay kept; turning it on again queues it again', async t => {
  const {relay, sent, start} = computer(t), chat = limitedChat('phone-chat', reset, refusal);
  const monitor = start();
  await publish([chat], monitor, refusal + 30_000);
  setAutoContinue('phone-chat', false);
  relay.reachable(false);
  await publish([chat], monitor, refusal + hour);
  relay.reachable(true);
  assert.deepEqual(offerDue(relay, sent, reset + 61_000), [], 'the copy the relay kept is refused at delivery');

  const other = limitedChat('phone-chat-2', reset, refusal);
  await publish([other], monitor, refusal + 30_000);
  setAutoContinue('phone-chat-2', false);
  await publish([other], monitor, refusal + hour);
  assert.deepEqual(relay.queued(), [], 'taken back from the relay');
  setAutoContinue('phone-chat-2', true);
  await publish([other], monitor, refusal + 2 * hour);
  assert.equal(relay.queued().length, 1, 'turned on again before the reset: queued again');
  assert.deepEqual(offerDue(relay, sent, reset + 2 * minute), [LIMIT_CONTINUE_PROMPT]);
});

test('a five-hour window that rolled over early still continues the chat at once, and only once', async t => {
  const {relay, sent, start} = computer(t), monitor = start();
  const resetsAt = Math.ceil((Date.now() + 3 * hour) / minute) * minute, refusedAt = resetsAt - 3 * hour;
  const chat = limitedChat('five-hour-chat', resetsAt, refusedAt, 'five_hour'), later = refusedAt + 10 * minute;
  await publish([chat], monitor, refusedAt);
  await publish([chat], monitor, later, () => [{provider: 'claude', limitId: 'claude', observedAt: later - minute,
    windows: [{id: 'primary', usedPercent: 100, windowMinutes: 300, resetsAt: resetsAt - 2 * hour}]}]);
  assert.deepEqual(offerDue(relay, sent, later + 1_000), [LIMIT_ROOM_PROMPT]);
  await publish([goingChat(chat, later + 2_000)], monitor, later + 30_000);
  await publish([goingChat(chat, later + 20 * minute, 'idle')], monitor, later + 21 * minute);
  assert.deepEqual(relay.queued(), [], 'it finished with room: the continuation at the reset is taken back');
  assert.deepEqual(offerDue(relay, sent, resetsAt + 2 * minute), []);
});
