import assert from 'node:assert/strict';
import test from 'node:test';
import { readAutomations } from '../store';
import { chat, day, fakeComputer, hour, isolatedComputer, minute } from './fixture';

const start = Date.UTC(2026, 10, 23, 8, 0);
const texts = (sent: { text: string }[]) => sent.map(message => message.text);

test('a due run goes into its free chat once, as a phone turn with the exact message, and logs one line', async t => {
  const { path } = isolatedComputer(t), computer = fakeComputer(path, start), claude = chat('claude-chat-1');
  computer.world.chats.set(claude.sessionId, claude);
  const created = await computer.create(claude, { kind: 'hours', every: 2 }, '  Check the build.\n');
  assert.equal(created.nextRunAt, start + 2 * hour);
  await computer.pass(start + 2 * hour - 1);
  assert.equal(computer.world.sent.length, 0);
  await computer.pass(start + 2 * hour + 5_000);
  await computer.pass(start + 2 * hour + 20_000);
  assert.deepEqual(texts(computer.world.sent), ['  Check the build.\n']);
  const [message] = computer.world.sent;
  assert.equal(message!.sessionId, claude.sessionId);
  assert.equal(message!.agent, 'claude');
  assert.match(message!.messageId!, /^automation-[a-f0-9]{40}$/);
  assert.deepEqual(computer.world.lines, [`[monitor] Automation ${created.id.slice(4, 12)} in chat claude-c: ran (due 2026-11-23 10:00 UTC).`]);
  const [row] = readAutomations(path).automations;
  assert.deepEqual(row!.last, { at: start + 2 * hour + 5_000, outcome: 'ran', dueAt: start + 2 * hour });
  assert.equal(row!.nextRunAt, start + 4 * hour);
  assert.doesNotMatch(computer.world.lines.join('\n'), /Check the build|Fixture/, 'the log never carries the words');
});

test('a busy chat makes the run wait, and a run still waiting at the next one gives way to it', async t => {
  const { path } = isolatedComputer(t), computer = fakeComputer(path, start), claude = chat('busy-chat');
  computer.world.chats.set(claude.sessionId, { ...claude, state: 'working' });
  const created = await computer.create(claude, { kind: 'hours', every: 1 });
  await computer.pass(start + hour);
  assert.deepEqual((await computer.ask(claude)).automations[0].waiting, { dueAt: start + hour, reason: 'busy' });
  computer.world.chats.set(claude.sessionId, { ...claude, state: 'idle', backgroundTasks: 1 });
  await computer.pass(start + hour + 30 * minute);
  computer.world.chats.set(claude.sessionId, claude);
  computer.world.inFlight.add(claude.sessionId);
  await computer.pass(start + hour + 40 * minute);
  assert.equal(computer.world.sent.length, 0, 'background work and a run in progress keep it waiting');
  computer.world.inFlight.delete(claude.sessionId);
  computer.world.queued.set(claude.sessionId, 2);
  await computer.pass(start + 2 * hour + 1_000);
  assert.equal(computer.world.sent.length, 0);
  assert.equal(computer.world.lines.length, 1);
  assert.match(computer.world.lines[0]!, new RegExp(`${created.id.slice(4, 12)} in chat busy-cha: skipped \\(due 2026-11-23 09:00 UTC\\): The chat was not free until the next run\\.$`));
  computer.world.queued.delete(claude.sessionId);
  await computer.pass(start + 2 * hour + 16_000);
  await computer.pass(start + 2 * hour + 31_000);
  assert.equal(computer.world.sent.length, 1, 'only the newer run went');
  assert.equal(readAutomations(path).automations[0]!.last?.dueAt, start + 2 * hour);
});

test('after the computer slept, one missed run goes and the others are skipped in one line', async t => {
  const { path } = isolatedComputer(t), computer = fakeComputer(path, start), claude = chat('sleepy-chat');
  computer.world.chats.set(claude.sessionId, claude);
  await computer.create(claude, { kind: 'hours', every: 1 });
  // Asleep from 08:00 until 13:20: the 09:00 to 13:00 runs were all missed.
  await computer.pass(start + 5 * hour + 20 * minute);
  await computer.pass(start + 5 * hour + 21 * minute);
  assert.equal(computer.world.sent.length, 1, 'never a burst');
  assert.equal(computer.world.lines.length, 2);
  assert.match(computer.world.lines[0]!, /skipped 4 runs \(due 2026-11-23 09:00 UTC\): The computer was asleep or GrantTap was not running when it was due\.$/);
  assert.match(computer.world.lines[1]!, /ran \(due 2026-11-23 13:00 UTC\)\.$/);
  assert.equal(readAutomations(path).automations[0]!.nextRunAt, start + 6 * hour);
});

test('a daily run found more than 12 hours late is skipped, and the next day it runs on time', async t => {
  const { path } = isolatedComputer(t), computer = fakeComputer(path, start), claude = chat('daily-chat');
  computer.world.chats.set(claude.sessionId, claude);
  const nine = new Date(start); nine.setHours(9, 0, 0, 0);
  const created = await computer.create(claude, { kind: 'daily', hour: nine.getHours(), minute: 0, weekdays: [] });
  const due = created.nextRunAt as number;
  await computer.pass(due + 13 * hour);
  assert.equal(computer.world.sent.length, 0);
  const [row] = readAutomations(path).automations;
  assert.equal(row!.last?.outcome, 'skipped');
  assert.equal(row!.last?.reason, 'The computer was asleep or GrantTap was not running when it was due.');
  assert.equal(row!.nextRunAt, due + day);
  await computer.pass(due + day + 1_000);
  assert.equal(computer.world.sent.length, 1);
  // Woken six hours late the day after: still worth running once.
  await computer.pass(due + 2 * day + 6 * hour);
  assert.equal(computer.world.sent.length, 2);
});

test('a usage limit holds the run until its reset, never fires into it, and gives way if it outlasts the next run', async t => {
  const { path } = isolatedComputer(t), computer = fakeComputer(path, start), claude = chat('limited-chat');
  const resetsAt = start + 2 * hour + 30 * minute;
  computer.world.chats.set(claude.sessionId, { ...claude, usageLimit: { resetsAt, window: 'five_hour' } });
  await computer.create(claude, { kind: 'hours', every: 2 });
  await computer.pass(start + 2 * hour);
  assert.deepEqual((await computer.ask(claude)).automations[0].waiting,
    { dueAt: start + 2 * hour, reason: 'limit', until: resetsAt + minute });
  await computer.pass(resetsAt + 30_000);
  assert.equal(computer.world.sent.length, 0, 'not in the grace minute after the reset');
  // The limit continuation is due a minute after the reset and goes first.
  computer.world.continuations.add(claude.sessionId);
  await computer.pass(resetsAt + 61_000);
  assert.equal(computer.world.sent.length, 0);
  computer.world.continuations.delete(claude.sessionId);
  await computer.pass(resetsAt + 2 * minute);
  assert.equal(computer.world.sent.length, 1);
  // A weekly limit outlasts the next run: that run is skipped with why, in one line.
  computer.world.chats.set(claude.sessionId, { ...claude, usageLimit: { resetsAt: start + 3 * day, window: 'seven_day' } });
  await computer.pass(start + 4 * hour);
  await computer.pass(start + 6 * hour);
  assert.equal(computer.world.sent.length, 1);
  assert.match(computer.world.lines.at(-1)!, /skipped \(due 2026-11-23 12:00 UTC\): The usage limit had not reset by the next run\.$/);
});

test("the account's own readings hold a run when its window is used up, though the chat was never refused", async t => {
  const { path } = isolatedComputer(t), computer = fakeComputer(path, start), claude = chat('account-chat');
  computer.world.chats.set(claude.sessionId, claude);
  await computer.create(claude, { kind: 'hours', every: 1 });
  const windowEnds = start + 3 * hour;
  const reading = (usedPercent: number, observedAt: number, label?: string) => ({ provider: 'claude' as const,
    limitId: label ? 'claude:model:opus' : 'claude', ...(label ? { label } : {}), observedAt,
    windows: [{ id: 'primary' as const, usedPercent, windowMinutes: 300, resetsAt: windowEnds }] });
  computer.world.readings = [reading(100, start + hour - minute), reading(100, start + hour - minute, 'Opus')];
  await computer.pass(start + hour);
  assert.equal((await computer.ask(claude)).automations[0].waiting.until, windowEnds + minute);
  computer.world.readings = [reading(100, start + hour - 20 * minute)];
  await computer.pass(start + hour + 15_000);
  assert.equal(computer.world.sent.length, 1, 'a reading older than ten minutes says nothing about now');
  computer.world.readings = [reading(40, start + 2 * hour - minute), reading(100, start + 2 * hour - minute, 'Opus')];
  await computer.pass(start + 2 * hour);
  assert.equal(computer.world.sent.length, 2, 'below the limit, and another model\'s limit does not hold it');
});

test('Run now goes once at the next pass, waits for a busy chat, and leaves the schedule as it was', async t => {
  const { path } = isolatedComputer(t), computer = fakeComputer(path, start), claude = chat('manual-chat');
  computer.world.chats.set(claude.sessionId, { ...claude, state: 'working' });
  const created = await computer.create(claude, { kind: 'hours', every: 6 }, 'Run me now.');
  const answer = await computer.ask(claude, { kind: 'run', id: created.id });
  assert.deepEqual(answer.automations[0].waiting, { dueAt: start, reason: 'checking', manual: true });
  await computer.pass(start + 15_000);
  assert.equal(computer.world.sent.length, 0);
  computer.world.chats.set(claude.sessionId, claude);
  await computer.pass(start + 30_000);
  assert.deepEqual(texts(computer.world.sent), ['Run me now.']);
  assert.match(computer.world.lines[0]!, /ran with Run now \(due 2026-11-23 08:00 UTC\)\.$/);
  const [row] = readAutomations(path).automations;
  assert.equal(row!.nextRunAt, start + 6 * hour);
  assert.deepEqual(row!.last, { at: start + 30_000, outcome: 'ran', dueAt: start, manual: true });
});

test('two automations due together in one chat go one after the other, never at once', async t => {
  const { path } = isolatedComputer(t), computer = fakeComputer(path, start), claude = chat('shared-chat');
  computer.world.chats.set(claude.sessionId, claude);
  await computer.create(claude, { kind: 'hours', every: 1 }, 'First.');
  await computer.create(claude, { kind: 'hours', every: 1 }, 'Second.');
  await computer.pass(start + hour);
  assert.deepEqual(texts(computer.world.sent), ['First.']);
  computer.world.chats.set(claude.sessionId, { ...claude, state: 'working' });
  await computer.pass(start + hour + 15_000);
  computer.world.chats.set(claude.sessionId, claude);
  await computer.pass(start + hour + 30 * minute);
  assert.deepEqual(texts(computer.world.sent), ['First.', 'Second.']);
});

test('a refused delivery is recorded as failed with why, and the next run is tried again', async t => {
  const { path } = isolatedComputer(t), computer = fakeComputer(path, start), claude = chat('gone-chat');
  await computer.create(claude, { kind: 'hours', every: 1 });
  computer.world.refuse = 'This task is no longer available on the computer.';
  await computer.pass(start + hour);
  assert.match(computer.world.lines[0]!, /failed \(due 2026-11-23 09:00 UTC\): This task is no longer available on the computer\.$/);
  assert.deepEqual(readAutomations(path).automations[0]!.last, { at: start + hour, outcome: 'failed', dueAt: start + hour,
    reason: 'This task is no longer available on the computer.' });
  computer.world.refuse = undefined;
  await computer.pass(start + 2 * hour);
  assert.equal(computer.world.sent.length, 1);
});

test('a one-time run goes once; one that never finds its chat free gives up after a week', async t => {
  const { path } = isolatedComputer(t), computer = fakeComputer(path, start), claude = chat('once-chat');
  computer.world.chats.set(claude.sessionId, claude);
  await computer.create(claude, { kind: 'once', at: start + hour });
  await computer.pass(start + hour);
  await computer.pass(start + 2 * hour);
  assert.equal(computer.world.sent.length, 1);
  assert.equal(readAutomations(path).automations[0]!.nextRunAt, undefined);
  const stuck = chat('stuck-chat');
  computer.world.chats.set(stuck.sessionId, { ...stuck, state: 'working' });
  await computer.create(stuck, { kind: 'once', at: start + 3 * hour });
  await computer.pass(start + 3 * hour);
  await computer.pass(start + 3 * hour + 7 * day);
  assert.equal(readAutomations(path).automations[1]!.pending?.dueAt, start + 3 * hour);
  await computer.pass(start + 3 * hour + 7 * day + 3 * hour);
  const [, row] = readAutomations(path).automations;
  assert.equal(row!.pending, undefined);
  assert.equal(row!.last?.reason, 'The chat was not free in the 7 days after it was due.');
  assert.equal(computer.world.sent.length, 1);
});

test('a chat paused from the phone and an update draining the monitor keep runs waiting', async t => {
  const { path } = isolatedComputer(t), computer = fakeComputer(path, start), claude = chat('update-chat');
  computer.world.chats.set(claude.sessionId, { ...claude, paused: true });
  await computer.create(claude, { kind: 'hours', every: 1 });
  await computer.pass(start + hour);
  assert.equal((await computer.ask(claude)).automations[0].waiting.reason, 'paused');
  computer.world.chats.set(claude.sessionId, claude);
  computer.world.updating = true;
  await computer.pass(start + hour + 15_000);
  assert.equal((await computer.ask(claude)).automations[0].waiting.reason, 'update');
  computer.world.updating = false;
  await computer.pass(start + hour + 30_000);
  assert.equal(computer.world.sent.length, 1);
});
