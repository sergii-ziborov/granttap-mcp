import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskJobHttpError } from '../../../../../../packages/core/task-job-http';
import { queueFailureReporter, transientQueueFailure } from '../failure-report';

const closed = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'),
  { code: 'UND_ERR_SOCKET' }) });

test('a network blip stays out of the log; a lasting outage and a storage fault are reported', () => {
  let at = 0;
  const lines: string[] = [];
  const reporter = queueFailureReporter(line => { lines.push(line); }, () => at);
  for (at = 1_000; at <= 21_000; at += 2_000) reporter.report(closed());
  assert.deepEqual(lines, [], 'Twenty seconds of retries are not news.');
  at = 60_000;
  reporter.report(closed());
  assert.deepEqual(lines, [], 'A failure after a quiet gap starts a new outage.');
  for (at = 62_000; at <= 92_000; at += 2_000) reporter.report(closed());
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /Relay task queue unreachable for 3\d s .*UND_ERR_SOCKET.*retrying/);
  at = 200_000;
  reporter.report(new Error('EACCES: task-dispatch'));
  assert.match(lines[1]!, /needs storage or relay recovery/);
  assert.equal(transientQueueFailure(new TaskJobHttpError(503)), true);
  assert.equal(transientQueueFailure(new TaskJobHttpError(401)), false);
});
