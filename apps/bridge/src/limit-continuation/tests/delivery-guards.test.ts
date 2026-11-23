import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import {TaskJobHttpError} from '../../../../../packages/core/task-job-http';
import type {UserMessage} from '../../../../../packages/protocol/schema';
import {annotateLimitContinuations, LIMIT_CONTINUE_PROMPT, limitContinuationFor, limitContinuationUnwanted,
  scheduleLimitContinuations, setAutoContinue, type ContinuationQueue} from '..';
import {logContinuation} from '../log';
import {failureReason} from '../relay-copies';
import {continuationLog, day, fakeRelay, goingChat, hour, isolatedComputer, limitedChat, machineConfig, minute,
  monitorProcess, offerDue} from './relay-fixture';

const reset = Math.ceil((Date.now() + 2 * day) / hour) * hour, refusal = reset - day;
function computer(t: {after: (fn: () => void) => void}) {
  const {root, senderRoot} = isolatedComputer(t), relay = fakeRelay(), sent = new Map<string, UserMessage>();
  return {root, relay, sent, monitor: monitorProcess(senderRoot, machineConfig(), relay, sent)};
}

test('a chat that went on just before its continuation came back does not get it as well', async t => {
  const {relay, sent, monitor} = computer(t), log = continuationLog(t);
  const chat = limitedChat('raced-chat', reset, refusal);
  await scheduleLimitContinuations([chat], monitor, refusal + 30_000);
  // The person wrote at the reset; the turn ended before the monitor's next look at the catalog.
  const answered = goingChat(chat, reset + 20_000, 'idle');
  assert.deepEqual(offerDue(relay, sent, reset + 61_000, answered), []);
  assert.match(log.at(-1)!, /skipped at delivery: the chat went on\.$/);
  await scheduleLimitContinuations([answered], monitor, reset + 90_000);
  assert.deepEqual(relay.queued(), []);
});

test('a chat its reset refused once more waits a quarter of an hour for the next continuation', async t => {
  const {relay, sent, monitor} = computer(t);
  const chat = (activity: number) => limitedChat('late-window-chat', reset, activity);
  await scheduleLimitContinuations([chat(refusal)], monitor, refusal + 30_000);
  assert.deepEqual(offerDue(relay, sent, reset + 61_000, chat(refusal)), [LIMIT_CONTINUE_PROMPT]);
  // The provider's window opened late: the continuation was refused by the same reset.
  await scheduleLimitContinuations([chat(reset + 70_000)], monitor, reset + 90_000);
  assert.deepEqual(offerDue(relay, sent, reset + 3 * minute, chat(reset + 70_000)), [], 'not again at once');
  assert.deepEqual(offerDue(relay, sent, reset + 17 * minute, chat(reset + 70_000)), [LIMIT_CONTINUE_PROMPT]);
  assert.equal(limitContinuationFor('late-window-chat').continuation?.dueAt, reset + 61_000 + 15 * minute);
});

test('an unreadable state stops the pass with one log line, and nothing is delivered on a guess', async t => {
  const {root, monitor, relay} = computer(t), log = continuationLog(t);
  mkdirSync(join(root, 'limit-continuation.json'));
  const chat = limitedChat('unreadable-chat', reset, refusal);
  await scheduleLimitContinuations([chat], monitor, refusal + 30_000);
  await scheduleLimitContinuations([chat], monitor, refusal + minute);
  assert.equal(log.length, 1);
  assert.match(log[0]!, /^\[monitor\] Continuations after subscription limits wait: their state could not be read or saved/);
  assert.deepEqual(relay.queued(), []);
  assert.equal(annotateLimitContinuations([chat])[0]?.usageLimit?.autoContinue, true, 'the catalog still says what it can');
  assert.deepEqual(limitContinuationFor('unreadable-chat'), {autoContinue: true});
  const message = {type: 'user.message', messageId: 'limit-continue-from-before', sessionId: 'unreadable-chat', text: 'x',
    createdAt: refusal} as UserMessage;
  assert.equal(limitContinuationUnwanted(message), true);
  assert.match(log.at(-1)!, /skipped at delivery: its state could not be read or saved/);
  assert.throws(() => setAutoContinue('unreadable-chat', false), 'the chats turned off are never replaced unseen');
});

test('catalogs that come while a pass waits on the relay do not queue a second copy', async t => {
  isolatedComputer(t);
  let release: () => void = () => {};
  const submitted: string[] = [];
  const slow: ContinuationQueue = {cancel: async () => {}, submit: async (_scope, message) => {
    submitted.push(message.messageId!);
    await new Promise<void>(resolve => { release = resolve; });
  }};
  const chat = limitedChat('slow-relay-chat', reset, refusal);
  const first = scheduleLimitContinuations([chat], slow, refusal + 30_000);
  const second = scheduleLimitContinuations([chat], slow, refusal + 60_000);
  assert.equal(second, first, 'the second catalog waits for the pass already running');
  await new Promise(resolve => setImmediate(resolve));
  release();
  await first;
  await scheduleLimitContinuations([chat], slow, refusal + 90_000);
  assert.equal(submitted.length, 1);
});

test('a copy the relay cannot be asked about is left alone until it answers', async t => {
  const {relay, sent, monitor} = computer(t);
  const chat = limitedChat('quiet-relay-chat', reset, refusal);
  await scheduleLimitContinuations([chat], monitor, refusal + 30_000);
  const [id] = relay.queued();
  relay.reachable(false);
  await scheduleLimitContinuations([chat], monitor, refusal + 2 * hour);
  relay.reachable(true);
  assert.deepEqual(relay.queued(), [id]);
  await scheduleLimitContinuations([chat], monitor, refusal + 2 * hour + minute);
  assert.deepEqual(relay.queued(), [id], 'it was there all along');
  assert.deepEqual(offerDue(relay, sent, reset + 61_000, chat), [LIMIT_CONTINUE_PROMPT]);
});

test('a job an older monitor recorded keeps both its copies, and is queued again under a new id once the relay lost it', async t => {
  const {root, relay, sent, monitor} = computer(t);
  writeFileSync(join(root, 'limit-continuation.json'), JSON.stringify({off: [], tried: {'legacy-chat': reset},
    scheduled: {'legacy-chat': {resetsAt: reset, messageId: 'limit-continue-legacy-regular', early: 'limit-continue-early-legacy',
      scope: {sessionId: 'legacy-chat', provider: 'claude', projectId: 'project-legacy'}, scheduledAt: refusal}}}));
  const chat = limitedChat('legacy-chat', reset, refusal, 'seven_day', {projectId: 'project-legacy'});
  await scheduleLimitContinuations([chat], {submit: monitor.submit, cancel: monitor.cancel}, refusal + hour);
  assert.deepEqual(relay.queued(), [], 'a queue that cannot be asked leaves the copies the old monitor put there');
  assert.deepEqual(limitContinuationFor('legacy-chat').continuation, {dueAt: reset + minute, early: true});
  await scheduleLimitContinuations([chat], {...monitor, status: async () => null}, refusal + 2 * hour);
  const [again] = relay.queued();
  assert.match(again ?? '', /^limit-continue-(?!legacy)/);
  assert.equal(sent.get(again!)?.projectId, 'project-legacy');
  const legacy = {type: 'user.message', messageId: 'limit-continue-legacy-regular', sessionId: 'legacy-chat', text: 'x',
    createdAt: refusal} as UserMessage;
  assert.equal(limitContinuationUnwanted(legacy, () => chat, reset + minute), true, 'the lost copy is not delivered');
  assert.deepEqual(offerDue(relay, sent, reset + minute, chat), [LIMIT_CONTINUE_PROMPT]);
});

test('log lines name the limit by its kind and why a copy could not reach the relay', t => {
  const lines = continuationLog(t), resetsAt = Date.UTC(2026, 10, 23, 11);
  for (const window of ['five_hour', 'seven_day', 'seven_day_opus', 'something_new', undefined]) {
    logContinuation({sessionId: 'abcdefgh-rest-of-id', window, resetsAt}, 'queued');
  }
  assert.deepEqual(lines.map(line => line.replace(/^\[monitor\] Continuation of chat abcdefgh after its /, '')), [
    '5-hour limit', 'weekly limit', 'weekly opus limit', 'something_new limit', 'subscription limit']
    .map(limit => `${limit} (reset 2026-11-23 11:00 UTC): queued.`));
  assert.equal(failureReason(new TaskJobHttpError(429)), 'The relay did not confirm the queued task operation (HTTP 429)');
  assert.equal(failureReason('no route'), 'no route');
});
