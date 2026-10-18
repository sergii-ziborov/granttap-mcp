import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { networkFixture } from '../../tests/fixture';
import { TaskNetworkStore } from '../../index';
import { ProjectConfigurationSync } from '../sync';
import { TaskNetworkHttpError } from '../../transport/http';

test('absent Project configuration backs off background polling without authorizing automatic work', async () => {
  const f = networkFixture();
  try {
    let now = Date.now(), reads = 0;
    const sync = new ProjectConfigurationSync({ config: f.targetConfig,
      store: new TaskNetworkStore(join(f.root, 'poll'), 'target', f.target.publicKey),
      controllers: () => [], controllerAllowed: () => false, projectAllowed: () => true,
      now: () => now, request: async () => { reads++; throw new TaskNetworkHttpError(404); } });
    for (let tick = 0; tick < 20; tick++) {
      assert.equal(await sync.refresh('missing', { background: true }), false);
      now += 2_000;
    }
    assert.equal(reads, 1, 'A missing opt-in configuration must not produce a request every monitor tick.');
    assert.equal(await sync.refresh('missing'), false);
    assert.equal(reads, 2, 'An actual admission always checks fresh permission despite background backoff.');
    now += 15 * 60_000;
    assert.equal(await sync.refresh('missing', { background: true }), false);
    assert.equal(reads, 3, 'Offline discovery resumes after the bounded absence delay.');
  } finally { f.cleanup(); }
});

test('relay failure backs off background polling and never revives a stale permission', async () => {
  const f = networkFixture();
  try {
    let now = Date.now(), reads = 0;
    const sync = new ProjectConfigurationSync({ config: f.targetConfig,
      store: new TaskNetworkStore(join(f.root, 'failure'), 'target', f.target.publicKey),
      controllers: () => [], controllerAllowed: () => false, projectAllowed: () => true,
      now: () => now, request: async () => { reads++; throw new TaskNetworkHttpError(503); } });
    assert.equal(await sync.refresh('project', { background: true }), false);
    now += 30_000;
    assert.equal(await sync.refresh('project', { background: true }), false);
    assert.equal(reads, 1);
    now += 31_000;
    assert.equal(await sync.refresh('project', { background: true }), false);
    assert.equal(reads, 2);
  } finally { f.cleanup(); }
});
