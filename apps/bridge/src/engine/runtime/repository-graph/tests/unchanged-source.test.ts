import assert from 'node:assert/strict';
import test from 'node:test';
import { RepositoryGraphJobs } from '../../repository-graph-jobs';
import { RepositoryGraphCache } from '../cache';
import type { ProjectRepositoryGraph } from '../../../../../../../packages/protocol/schema';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('elapsed time alone does not rescan a repository whose observed source is unchanged', async () => {
  let now = 1_000, scans = 0;
  const jobs = new RepositoryGraphJobs<string>(() => now, 100, 200);
  const source = { fingerprint: 'same-source' };
  const scan = async () => { scans++; return 'actual graph'; };
  await jobs.refresh('repository', scan, 1, source);
  now += 1_000;
  assert.equal(jobs.read('repository', scan, 1, false, source), 'actual graph');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scans, 1, 'A timer must not repeatedly trigger a full native parser');
  await jobs.refresh('repository', scan, 1, source);
  assert.equal(scans, 2, 'Explicit refresh still forces a native observation');
});

test('changed source is refreshed after cooldown, while failed observations are never frozen', async () => {
  let now = 0, scans = 0;
  const jobs = new RepositoryGraphJobs<string>(() => now, 100, 200);
  const scan = async () => { scans++; return scans === 1 ? 'unavailable' : 'ready'; };
  const original = { fingerprint: 'source-one', reusable: (value: string) => value === 'ready' };
  await jobs.refresh('repo', scan, 1, original);
  now = 101;
  jobs.read('repo', scan, 1, false, original);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scans, 2, 'A temporary failure must recover with unchanged source');
  now = 1_000;
  jobs.read('repo', scan, 1, false, original);
  assert.equal(scans, 2);
  const changed = { ...original, fingerprint: 'source-two' };
  jobs.read('repo', scan, 1, false, changed);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scans, 3);
  jobs.read('repo', scan, 1, false, { ...original, fingerprint: 'source-three' });
  assert.equal(scans, 3, 'Rapid edits retain the existing bounded cooldown');
  now += 101;
  jobs.read('repo', scan, 1, false, { ...original, fingerprint: 'source-three' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scans, 4);
});

test('a successful source observation survives restart without another native parse', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'granttap-source-graph-cache-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = 1_000, scans = 0;
  const cache = new RepositoryGraphCache(directory, () => now);
  const source = { fingerprint: 'a'.repeat(64) };
  const graph: ProjectRepositoryGraph = { projectId: 'p', repositoryId: 'r', revision: 'contents',
    weavatrixVersion: '2.17.4', analysisStatus: 'COMPLETE', nodes: [], relations: [],
    totalNodes: 0, totalRelations: 0, truncated: false };
  const scan = async () => { scans++; return graph; };
  const first = new RepositoryGraphJobs<ProjectRepositoryGraph>(() => now, 100, 200, 32, cache);
  await first.refresh('repo', scan, 1, source);
  assert.equal(cache.read('repo')?.sourceFingerprint, source.fingerprint);
  now += 1_000;
  const restarted = new RepositoryGraphJobs<ProjectRepositoryGraph>(() => now, 100, 200, 32, cache);
  assert.equal(restarted.read('repo', scan, 1, false, source)?.revision, 'contents');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scans, 1);
  await restarted.refresh('repo', scan, 1, source);
  assert.equal(scans, 2);
});
