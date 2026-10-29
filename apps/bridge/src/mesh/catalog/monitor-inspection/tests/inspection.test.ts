import assert from 'node:assert/strict';
import test from 'node:test';
import { createMonitorInspection } from '..';

test('stable metadata is shared across catalog ticks while uncommitted work is freshly observed', async () => {
  let metadataReads = 0, statusReads = 0, dirty = false;
  const prepare = createMonitorInspection({ now: () => 1_000,
    repository: async root => { metadataReads++; return { root, canonicalRepositoryId: 'repo', revision: 'HEAD', worktree: root }; },
    workingTree: async () => { statusReads++; return dirty; } });
  const first = await prepare(['/project', '/project']);
  assert.equal(first.repository('/project').revision, 'HEAD');
  assert.equal(first.workingTree('/project'), false);
  dirty = true;
  const second = await prepare(['/project']);
  assert.equal(second.workingTree('/project'), true, 'Editing without touching the Git index must remain visible');
  assert.equal(statusReads, 2);
  assert.equal(metadataReads, 1, 'An unchanged catalog must not repeatedly spawn Git metadata commands');
});

test('an explicit refresh verifies changed native metadata even within the observation window', async () => {
  let revision = 'old';
  const prepare = createMonitorInspection({ now: () => 1_000,
    repository: async root => ({ root, canonicalRepositoryId: 'repo', revision, worktree: root }),
    workingTree: async () => undefined });
  assert.equal((await prepare(['/project'])).repository('/project').revision, 'old');
  revision = 'new';
  assert.equal((await prepare(['/project'], true)).repository('/project').revision, 'new');
});

test('expired, retired and backwards-clock observations are refreshed without altering older snapshots', async () => {
  let now = 1_000, reads = 0;
  const facts = { root: '/project', canonicalRepositoryId: 'repo', revision: 'old', worktree: '/project' };
  const prepare = createMonitorInspection({ now: () => now,
    repository: async () => { reads++; return facts; }, workingTree: async () => false });
  const old = await prepare(['/project']);
  facts.revision = 'new';
  assert.equal(old.repository('/project').revision, 'old');
  now += 31_000;
  assert.equal((await prepare(['/project'])).repository('/project').revision, 'new');
  assert.equal(reads, 2);
  now = 0;
  await prepare(['/project']);
  assert.equal(reads, 3);
  await prepare([]);
  await prepare(['/project']);
  assert.equal(reads, 4);
});

test('an older in-flight observation cannot overwrite a forced refresh', async () => {
  let reads = 0;
  const finish: Array<(revision: string) => void> = [];
  const prepare = createMonitorInspection({ now: () => 1_000,
    repository: root => new Promise(resolve => { reads++; finish.push(revision => resolve({ root,
      canonicalRepositoryId: 'repo', revision, worktree: root })); }), workingTree: async () => undefined });
  const old = prepare(['/project']), newer = prepare(['/project'], true);
  finish[1]!('new');
  assert.equal((await newer).repository('/project').revision, 'new');
  finish[0]!('old');
  assert.equal((await old).repository('/project').revision, 'old');
  assert.equal((await prepare(['/project'])).repository('/project').revision, 'new');
  assert.equal(reads, 2);
});
