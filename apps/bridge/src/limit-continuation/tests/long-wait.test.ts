import assert from 'node:assert/strict';
import test from 'node:test';
import type {ProviderAccountUsage, UserMessage} from '../../../../../packages/protocol/schema';
import {LIMIT_CONTINUE_PROMPT, LIMIT_ROOM_PROMPT, scheduleLimitContinuations} from '..';
import {continuationLog, day, fakeRelay, goingChat, hour, isolatedComputer, limitedChat, machineConfig, minute,
  monitorProcess, offerDue} from './relay-fixture';

// Chat f15f2ebf: refused by its weekly window on Nov 17 at 11:59Z with a reset on Nov 23 at 11:00Z, continued
// early at 12:16Z because the readings showed room, and refused again for that same reset on Nov 19 at 00:32Z.
// The relay checks times against the real clock, so the story is told from a reset six days ahead.
const reset = Math.ceil((Date.now() + 6 * day) / hour) * hour;
const firstRefusal = reset - (5 * day + 23 * hour + minute), earlyAt = firstRefusal + 17 * minute;
const secondRefusal = reset - (4 * day + 10 * hour + 28 * minute);
const weekly = (observedAt: number, usedPercent: number): ProviderAccountUsage => ({provider: 'claude', limitId: 'claude',
  observedAt, windows: [{id: 'secondary', usedPercent, windowMinutes: 10_080, resetsAt: reset}]});

test('a weekly limit hit again for the same reset after an early try is continued at the reset, across an update', async t => {
  const {senderRoot} = isolatedComputer(t), log = continuationLog(t);
  const relay = fakeRelay(), config = machineConfig(), sent = new Map<string, UserMessage>();
  const chat = (activity: number) => limitedChat('f15f2ebf-weekly', reset, activity);
  const delivered: string[] = [];
  let monitor = monitorProcess(senderRoot, config, relay, sent);

  await scheduleLimitContinuations([chat(firstRefusal)], monitor, firstRefusal + 30_000);
  await scheduleLimitContinuations([chat(firstRefusal)], monitor, earlyAt, () => [weekly(earlyAt - 30_000, 72)]);
  delivered.push(...offerDue(relay, sent, earlyAt + 5_000, chat(firstRefusal)));
  assert.deepEqual(delivered, [LIMIT_ROOM_PROMPT], 'the readings showed room: the chat went on at once');
  await scheduleLimitContinuations([goingChat(chat(firstRefusal), earlyAt + 6_000)], monitor, earlyAt + 30_000);
  assert.deepEqual(relay.queued(), [], 'the chat went on: the continuation at the reset is taken back');

  // Thirty-six hours of work later the same weekly window refuses it again, as Update 0.8.198 takes over: the
  // relay has not answered when the old monitor is replaced.
  relay.reachable(false);
  await scheduleLimitContinuations([chat(secondRefusal)], monitor, secondRefusal + 20_000);
  relay.reachable(true);
  monitor = monitorProcess(senderRoot, config, relay, sent);
  await monitor.retryPending();
  await scheduleLimitContinuations([chat(secondRefusal)], monitor, secondRefusal + 20 * minute);
  assert.equal(relay.queued().length, 1, 'the continuation at the reset is queued again, once');
  // A day later the Mac restarts; the chat has left the lists the catalog publishes.
  monitor = monitorProcess(senderRoot, config, relay, sent);
  await scheduleLimitContinuations([], monitor, secondRefusal + day);
  await scheduleLimitContinuations([chat(secondRefusal)], monitor, reset - hour);
  assert.equal(relay.queued().length, 1, 'a restart finds the copy on the relay and leaves it');
  delivered.push(...offerDue(relay, sent, reset - minute, chat(secondRefusal)));
  assert.deepEqual(delivered, [LIMIT_ROOM_PROMPT], 'nothing goes before the reset');
  delivered.push(...offerDue(relay, sent, reset + 61_000, chat(secondRefusal)));
  assert.deepEqual(delivered, [LIMIT_ROOM_PROMPT, LIMIT_CONTINUE_PROMPT], 'continued once, a minute after the reset');
  assert.deepEqual(relay.queued(), []);

  const events = log.map(line => line.replace(/^.*\): /, ''));
  assert.ok(log.every(line => line.includes('chat f15f2ebf after its weekly limit')), 'each line names the chat and limit');
  assert.deepEqual(events.filter(line => !line.startsWith('not on the relay yet')).map(line => line.split(/[,:]/)[0]), [
    'queued', 'queued to go at once', 'delivered early', 'taken back', 'queued', 'delivered']);
  assert.match(events.find(line => line.startsWith('not on the relay yet')) ?? '', /relay unreachable/,
    'the relay that did not answer is in the log once');
  assert.match(events.at(-1)!, /^delivered, 1 min after the reset\.$/);
});

test('a continuation still waiting a week after its reset expires and is taken back', async t => {
  const {senderRoot} = isolatedComputer(t), log = continuationLog(t);
  const relay = fakeRelay(), sent = new Map<string, UserMessage>(), monitor = monitorProcess(senderRoot, machineConfig(), relay, sent);
  const chat = limitedChat('busy-for-a-week', reset, secondRefusal);
  await scheduleLimitContinuations([chat], monitor, secondRefusal + 30_000);
  // The chat was paused on the phone, so the relay's offers wait; it has not moved, and its limit left the
  // catalog an hour after the reset.
  const paused = goingChat(chat, secondRefusal, 'idle');
  await scheduleLimitContinuations([paused], monitor, reset + 6 * day);
  assert.equal(relay.queued().length, 1, 'six days after the reset it still waits');
  await scheduleLimitContinuations([paused], monitor, reset + 7 * day + 2 * minute);
  assert.deepEqual(relay.queued(), [], 'a week after the reset it is taken back');
  assert.match(log.at(-1)!, /expired: the chat was not free to take it in the 7 days after the reset\.$/);
});
