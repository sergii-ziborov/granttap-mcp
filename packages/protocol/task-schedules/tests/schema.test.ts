import assert from 'node:assert/strict';
import test from 'node:test';
import { Payload, TaskSchedulePatch, TaskSchedulesRequest, TaskSchedulesResult } from '../../schema';

test('automation edits have a strict typed path and preserve instruction whitespace', () => {
  const request = { type: 'task.schedules', sessionId: 'chat', requestId: 'query', createdAt: 1,
    change: { id: 'existing', revision: 'a'.repeat(64), patch: { prompt: '  retain this indentation\n' } } };
  assert.equal(TaskSchedulePatch.parse(request.change.patch).prompt, request.change.patch.prompt);
  assert.equal(Payload.parse(request).type, 'task.schedules');
  assert.equal(TaskSchedulesRequest.safeParse({ ...request, root: '/foreign' }).success, false);
  assert.equal(TaskSchedulesRequest.safeParse({ ...request, change: { ...request.change, patch: {} } }).success, false);
  assert.equal(TaskSchedulePatch.safeParse({ prompt: '   ' }).success, false);
});

test('replies are bounded and cannot repeat an automation identity', () => {
  const row = { id: 'existing', sessionId: 'native', name: 'Fixture', prompt: 'Fixture only.', rrule: 'FREQ=HOURLY',
    status: 'PAUSED', revision: 'a'.repeat(64), editable: true, confirmation: 'confirmed' };
  const result = { type: 'task.schedules.result', requestId: 'query', sessionId: 'chat', phase: 'completed',
    schedules: [row], truncated: false, timeZone: 'UTC', createdAt: 2 };
  assert.equal(Payload.parse(result).type, 'task.schedules.result');
  assert.equal(TaskSchedulesResult.safeParse({ ...result, schedules: [row, row] }).success, false);
  assert.equal(TaskSchedulesResult.safeParse({ ...result, schedules: Array.from({ length: 8 }, (_, index) => ({
    ...row, id: String(index), prompt: 'x'.repeat(8192),
  })) }).success, false);
});
