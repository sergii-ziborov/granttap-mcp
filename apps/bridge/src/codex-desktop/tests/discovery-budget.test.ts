import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { deliverToSession } from '../../reply';
import { fixture } from './fixture';

test('owner discovery may finish after five seconds without a false failure or competing CLI', async t => {
  const f = await fixture(t, undefined, { ownerDelayMs: 5_500 });
  const result = await deliverToSession(f.session, 'Synthetic delayed discovery', 15_000);
  assert.equal(result.ok, true);
  assert.equal(existsSync(f.marker), false);
  assert.equal(f.requests.filter(request => request.method === 'thread-follower-start-turn').length, 1);
});
