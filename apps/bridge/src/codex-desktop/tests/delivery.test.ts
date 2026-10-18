import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { deliverToSession } from '../../reply';
import { fixture } from './fixture';

test('a phone follow-up reaches the existing desktop owner without a competing CLI writer', async t => {
  const f = await fixture(t);
  const result = await deliverToSession(f.session, 'Synthetic native follow-up', 2_000);
  assert.equal(existsSync(f.marker), false, 'an open desktop thread must never launch exec resume');
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.text, '', 'the receipt is not a fabricated assistant reply');
  const sent = f.requests.find(request => request.method === 'thread-follower-start-turn');
  assert.equal(sent?.version, 2);
  assert.equal(sent?.targetClientId, 'native-owner');
  assert.equal(sent?.params.conversationId, f.session.sessionId);
  assert.deepEqual(sent?.params.turnStart.request.input,
    [{ type: 'text', text: 'Synthetic native follow-up', text_elements: [] }]);
  assert.equal(sent?.params.turnStart.request.threadId, f.session.sessionId);
  assert.equal(sent?.params.turnStart.request.approvalPolicy, undefined);
  assert.equal(sent?.params.turnStart.request.sandboxPolicy, undefined);
});

test('an idle desktop owner receives the same conversation and explicit model and effort', async t => {
  const f = await fixture(t);
  const result = await deliverToSession({ ...f.session, state: 'idle' }, 'Synthetic next turn', 2_000,
    [], { model: 'gpt-6.1-sol', effort: 'xhigh' });
  assert.equal(result.ok, true);
  assert.equal(existsSync(f.marker), false);
  const request = f.requests.find(r => r.method === 'thread-follower-start-turn')?.params.turnStart.request;
  assert.equal(request?.model, 'gpt-6.1-sol');
  assert.equal(request?.effort, 'xhigh');
  assert.equal(request?.cwd, undefined, 'a continuing turn inherits the owning desktop workspace');
});

test('a repeated delivery ID is acknowledged once without starting the native turn twice', async t => {
  const f = await fixture(t);
  const options = { messageId: randomUUID() };
  const first = await deliverToSession(f.session, 'Synthetic repeated message', 2_000, [], options);
  const second = await deliverToSession(f.session, 'Synthetic repeated message', 2_000, [], options);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(f.requests.filter(r => r.method === 'thread-follower-start-turn').length, 1);
});
