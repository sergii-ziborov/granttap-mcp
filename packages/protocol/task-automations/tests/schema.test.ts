import assert from 'node:assert/strict';
import test from 'node:test';
import { AutomationDraft, AutomationSchedule, MachineHeartbeat, Payload, TaskAutomationAction, TaskAutomationsRequest,
  TaskAutomationsResult } from '../../schema';

test('a request carries any change kind on the wire, so a newer phone is answered, and is strict otherwise', () => {
  const request = { type: 'task.automations', requestId: 'query', sessionId: 'chat', createdAt: 1,
    action: { kind: 'snooze', until: 5 } };
  assert.equal(Payload.parse(request).type, 'task.automations');
  assert.equal(TaskAutomationAction.safeParse(request.action).success, false);
  assert.equal(TaskAutomationsRequest.safeParse({ ...request, root: '/foreign' }).success, false);
  assert.equal(TaskAutomationsRequest.safeParse({ ...request, action: { until: 5 } }).success, false);
  const create = { kind: 'create', draft: { name: 'Nightly', prompt: '  keep\nthis\n', schedule: { kind: 'hours', every: 6 } } };
  assert.equal(TaskAutomationAction.parse(create).kind, 'create');
  assert.equal((TaskAutomationAction.parse(create) as any).draft.prompt, '  keep\nthis\n');
  assert.equal(TaskAutomationAction.safeParse({ kind: 'pause', id: 'x' }).success, false, 'a pause names the revision it saw');
  assert.equal(TaskAutomationAction.safeParse({ kind: 'run', id: 'x' }).success, true);
});

test('schedules are one of four strict forms with bounded fields', () => {
  for (const schedule of [{ kind: 'once', at: 1 }, { kind: 'hours', every: 168 }, { kind: 'daily', hour: 23, minute: 59, weekdays: [] },
    { kind: 'daily', hour: 0, minute: 0, weekdays: ['MO', 'SU'] }, { kind: 'cron', expression: '*/5 * * * *' }]) {
    assert.equal(AutomationSchedule.safeParse(schedule).success, true, JSON.stringify(schedule));
  }
  for (const schedule of [{ kind: 'once', at: 0 }, { kind: 'hours', every: 0 }, { kind: 'hours', every: 169 },
    { kind: 'daily', hour: 24, minute: 0, weekdays: [] }, { kind: 'daily', hour: 1, minute: 0, weekdays: ['MO', 'MO'] },
    { kind: 'daily', hour: 1, minute: 0 }, { kind: 'cron', expression: '* *' }, { kind: 'weekly' }, { kind: 'hours', every: 1, at: 2 }]) {
    assert.equal(AutomationSchedule.safeParse(schedule).success, false, JSON.stringify(schedule));
  }
  assert.equal(AutomationDraft.safeParse({ name: ' ', prompt: 'x', schedule: { kind: 'hours', every: 1 } }).success, false);
  assert.equal(AutomationDraft.safeParse({ name: 'x', prompt: ' \n', schedule: { kind: 'hours', every: 1 } }).success, false);
});

test('replies are bounded, cannot repeat an automation, and older heartbeats still parse', () => {
  const row = { id: 'gta-0123456789abcdef', sessionId: 'chat', agent: 'claude', name: 'Fixture', prompt: 'Fixture only.',
    schedule: { kind: 'hours', every: 1 }, status: 'ACTIVE', revision: 1, createdAt: 1, updatedAt: 1, nextRunAt: 3_600_001,
    waiting: { dueAt: 2, reason: 'limit', until: 9 }, last: { at: 1, outcome: 'skipped', count: 3, reason: 'Asleep.' } };
  const result = { type: 'task.automations.result', requestId: 'query', sessionId: 'chat', phase: 'completed',
    automations: [row], timeZone: 'UTC', createdAt: 2 };
  assert.equal(Payload.parse(result).type, 'task.automations.result');
  assert.equal(TaskAutomationsResult.safeParse({ ...result, automations: [row, row] }).success, false);
  assert.equal(TaskAutomationsResult.safeParse({ ...result, automations: Array.from({ length: 9 }, (_, index) => ({
    ...row, id: String(index), prompt: 'x'.repeat(8192) })) }).success, false);
  assert.equal(TaskAutomationsResult.safeParse({ ...result, automations: [{ ...row, agent: 'gemini' }] }).success, false);
  assert.equal(MachineHeartbeat.parse({ type: 'machine.heartbeat', machine: 'Mac', createdAt: 1 }).taskAutomations, undefined);
  assert.equal(MachineHeartbeat.parse({ type: 'machine.heartbeat', machine: 'Mac', createdAt: 1, taskAutomations: true })
    .taskAutomations, true);
});
