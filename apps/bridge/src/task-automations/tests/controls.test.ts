import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { TaskAutomationsResult } from '../../../../../packages/protocol/schema';
import { MAX_PER_CHAT } from '../controls';
import { readAutomations } from '../store';
import { chat, fakeComputer, hour, isolatedComputer, minute } from './fixture';

const start = Date.UTC(2026, 10, 23, 8, 0);

test('pause stops its runs, resume counts from then, and delete removes it; each names the revision it saw', async t => {
  const { path } = isolatedComputer(t), computer = fakeComputer(path, start), claude = chat('controlled-chat');
  computer.world.chats.set(claude.sessionId, claude);
  const created = await computer.create(claude, { kind: 'hours', every: 1 });
  assert.equal(created.revision, 1);
  const paused = await computer.ask(claude, { kind: 'pause', id: created.id, revision: 1 });
  assert.equal(paused.phase, 'completed');
  assert.equal(paused.changedId, created.id);
  assert.deepEqual([paused.automations[0].status, paused.automations[0].revision, paused.automations[0].nextRunAt],
    ['PAUSED', 2, undefined]);
  await computer.pass(start + 3 * hour);
  assert.equal(computer.world.sent.length, 0, 'a paused automation does not run');
  const stale = await computer.ask(claude, { kind: 'resume', id: created.id, revision: 1 });
  assert.deepEqual([stale.phase, stale.message], ['failed', 'This automation changed. Refresh before editing it.']);
  const resumed = await computer.ask(claude, { kind: 'resume', id: created.id, revision: 2 });
  assert.equal(resumed.automations[0].nextRunAt, start + 4 * hour, 'an hour after it was resumed, not on the old beat');
  await computer.pass(start + 4 * hour);
  assert.equal(computer.world.sent.length, 1);
  const deleted = await computer.ask(claude, { kind: 'delete', id: created.id, revision: 3 });
  assert.deepEqual([deleted.phase, deleted.automations], ['completed', []]);
  await computer.pass(start + 6 * hour);
  assert.equal(computer.world.sent.length, 1);
  const gone = await computer.ask(claude, { kind: 'run', id: created.id });
  assert.equal(gone.message, 'This automation is no longer on this computer. Refresh to see the current list.');
});

test('an edit keeps the schedule beat unless the schedule changed, and a pause drops a run that was waiting', async t => {
  const { path } = isolatedComputer(t), computer = fakeComputer(path, start), claude = chat('edited-chat');
  computer.world.chats.set(claude.sessionId, { ...claude, state: 'working' });
  const created = await computer.create(claude, { kind: 'hours', every: 2 });
  const draft = { name: 'Renamed', prompt: 'New words.', schedule: { kind: 'hours', every: 2 } };
  const renamed = await computer.ask(claude, { kind: 'update', id: created.id, revision: 1, draft });
  assert.deepEqual([renamed.automations[0].name, renamed.automations[0].prompt, renamed.automations[0].nextRunAt],
    ['Renamed', 'New words.', start + 2 * hour]);
  computer.world.now = start + 30 * minute;
  const moved = await computer.ask(claude, { kind: 'update', id: created.id, revision: 2,
    draft: { ...draft, schedule: { kind: 'hours', every: 3 } } });
  assert.equal(moved.automations[0].nextRunAt, start + 30 * minute + 3 * hour);
  await computer.pass(start + 4 * hour);
  assert.equal((await computer.ask(claude)).automations[0].waiting.reason, 'busy');
  await computer.ask(claude, { kind: 'pause', id: created.id, revision: 3 });
  computer.world.chats.set(claude.sessionId, claude);
  await computer.pass(start + 4 * hour + minute);
  assert.equal(computer.world.sent.length, 0);
  const past = await computer.ask(claude, { kind: 'update', id: created.id, revision: 4,
    draft: { ...draft, schedule: { kind: 'once', at: start } } });
  assert.deepEqual([past.phase, past.message], ['failed', 'Choose a time in the future.']);
});

test('a one-time automation that already ran can be renamed, but resumes only with a new time', async t => {
  const { path } = isolatedComputer(t), computer = fakeComputer(path, start), claude = chat('once-edit-chat');
  computer.world.chats.set(claude.sessionId, claude);
  const created = await computer.create(claude, { kind: 'once', at: start + hour });
  await computer.pass(start + hour);
  const draft = { name: 'Kept time', prompt: 'Same.', schedule: { kind: 'once', at: start + hour } };
  assert.equal((await computer.ask(claude, { kind: 'update', id: created.id, revision: 1, draft })).phase, 'completed');
  await computer.ask(claude, { kind: 'pause', id: created.id, revision: 2 });
  const resumed = await computer.ask(claude, { kind: 'resume', id: created.id, revision: 3 });
  assert.equal(resumed.message, 'Choose a time in the future to run it again.');
  assert.equal(readAutomations(path).automations[0]!.status, 'PAUSED');
});

test('a repeated request id changes nothing twice, and requests outside their window are not answered', async t => {
  const { path } = isolatedComputer(t), computer = fakeComputer(path, start), claude = chat('repeat-chat');
  const action = { kind: 'create', draft: { name: 'Once only', prompt: 'Go.', schedule: { kind: 'hours', every: 4 } } };
  const first = await computer.ask(claude, action, 'same-request');
  const again = await computer.ask(claude, action, 'same-request');
  assert.deepEqual(again, first);
  assert.equal(readAutomations(path).automations.length, 1);
  assert.equal(await computer.ask(claude, { ...action, draft: { ...action.draft, name: 'Other' } }, 'same-request'), undefined);
  const answers: unknown[] = [];
  const late = await computer.controls.handle({ type: 'task.automations', requestId: 'late', sessionId: claude.sessionId,
    createdAt: start - 3 * minute }, { controller: 'phone', scope: { chat: { sessionId: claude.sessionId, agent: 'claude' },
      sessions: [claude.sessionId] }, send: async result => { answers.push(result); } });
  assert.deepEqual([late, answers], [false, []]);
});

test('an unknown change, a bad schedule and a full chat are refused with sentences the phone can show', async t => {
  const { path } = isolatedComputer(t), computer = fakeComputer(path, start), claude = chat('refused-chat');
  const unknown = await computer.ask(claude, { kind: 'snooze', id: 'gta-0000000000000000' });
  assert.deepEqual([unknown.phase, unknown.message],
    ['failed', 'Update GrantTap MCP on this computer to use this automation change.']);
  const cron = await computer.ask(claude, { kind: 'create', draft: { name: 'Bad', prompt: 'x',
    schedule: { kind: 'cron', expression: '61 * * * *' } } });
  assert.equal(cron.message, 'Use five cron fields: minute, hour, day of month, month and weekday.');
  for (let index = 0; index < MAX_PER_CHAT; index++) await computer.create(claude, { kind: 'hours', every: 24 }, `Job ${index}`);
  const full = await computer.ask(claude, { kind: 'create', draft: { name: 'One more', prompt: 'x', schedule: { kind: 'hours', every: 1 } } });
  assert.equal(full.message, 'This chat already has the most automations it can keep.');
  assert.equal(TaskAutomationsResult.safeParse(full).success, true);
});

test("a Task's automations always fit one reply: a change that would not is refused", async t => {
  const { path } = isolatedComputer(t), computer = fakeComputer(path, start), claude = chat('long-chat');
  const long = 'Ж'.repeat(8192);
  for (let index = 0; index < 3; index++) await computer.create(claude, { kind: 'hours', every: 24 }, long);
  const refused = await computer.ask(claude, { kind: 'create', draft: { name: 'Too much', prompt: long, schedule: { kind: 'hours', every: 1 } } });
  assert.equal(refused.message, "This Task's automations are too long to list together. Shorten a message or delete an automation.");
  const listed = await computer.ask(claude);
  assert.equal(listed.automations.length, 3);
  assert.equal(listed.truncated, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(listed)) <= 65_536);
});

test("a chat lists its Task's automations on this computer and never another Task's", async t => {
  const { path } = isolatedComputer(t), computer = fakeComputer(path, start);
  const claude = chat('task-claude'), grok = chat('task-grok', { agent: 'grok' }), other = chat('other-task', { taskId: 'other' });
  await computer.create(claude, { kind: 'hours', every: 1 }, 'Claude work.');
  await computer.create(other, { kind: 'hours', every: 1 }, 'Private other Task.');
  const fromGrok = await computer.ask(grok);
  assert.deepEqual(fromGrok.automations.map((row: any) => [row.sessionId, row.agent]), [['task-claude', 'claude']]);
  assert.doesNotMatch(JSON.stringify(fromGrok), /Private other Task/);
  const foreign = await computer.ask(grok, { kind: 'delete', id: (await computer.ask(other)).automations[0].id, revision: 1 });
  assert.equal(foreign.phase, 'failed');
  assert.equal(readAutomations(path).automations.length, 2);
  assert.equal(readFileSync(path, 'utf8').includes('"version":1'), true);
});
