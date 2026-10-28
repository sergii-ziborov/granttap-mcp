import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computerCache, clearComputerCache } from '../cache';
import { saveState } from '../../runtime-updates/selection.mjs';

test('cleanup preserves active and rollback runtimes, credentials, chats, projects and external symlink targets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'granttap-cache-'));
  const updates = join(directory, 'runtime-updates');
  const version = (v: string) => join(updates, 'versions', v);
  const packageRoot = (v: string) => join(version(v), 'node_modules', 'granttap-mcp');
  for (const v of ['0.8.106', '0.8.107', '0.8.108', '0.8.109']) {
    await mkdir(packageRoot(v), { recursive: true }); await writeFile(join(version(v), 'bytes'), 'cache');
  }
  saveState(updates, { root: packageRoot('0.8.109'), version: '0.8.109', previous: { root: packageRoot('0.8.108'), version: '0.8.108' } });
  for (const name of ['machine.json', 'chat-history.json', 'project.go']) await writeFile(join(directory, name), 'keep');
  const graph = join(directory, 'repository-graph-cache'); await mkdir(graph); await writeFile(join(graph, 'index'), 'rebuild');
  await symlink(join(directory, 'project.go'), join(graph, 'external'));
  const caches = await computerCache(packageRoot('0.8.106'), directory, 'node ' + packageRoot('0.8.107'));
  assert.equal(caches[1]!.reclaimableBytes, 0, 'A running package and both selections stay protected');
  assert.equal(caches[0]!.bytes, 7, 'Symlinks are not followed or counted');
  await clearComputerCache(packageRoot('0.8.106'), directory);
  assert.equal(await readFile(join(directory, 'project.go'), 'utf8'), 'keep');
  assert.equal(await readFile(join(directory, 'machine.json'), 'utf8'), 'keep');
  assert.equal(await readFile(join(directory, 'chat-history.json'), 'utf8'), 'keep');
  assert.equal((await lstat(packageRoot('0.8.106'))).isDirectory(), true);
  assert.equal((await lstat(packageRoot('0.8.108'))).isDirectory(), true);
  assert.equal((await lstat(packageRoot('0.8.109'))).isDirectory(), true);
  await assert.rejects(lstat(graph), /ENOENT/);
});

test('cleanup does not race an installer or follow a symlinked graph root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'granttap-cache-guard-'));
  await mkdir(join(directory, 'runtime-updates'));
  await writeFile(join(directory, 'runtime-updates', 'install.lock'), 'installing');
  await assert.rejects(clearComputerCache('/current', directory), /in progress/);
  const target = await mkdtemp(join(tmpdir(), 'granttap-cache-external-'));
  await writeFile(join(target, 'keep.go'), 'package main');
  await symlink(target, join(directory, 'repository-graph-cache'));
  const cache = await computerCache('/current', directory, '');
  assert.equal(cache[0]!.bytes, 0);
  assert.equal(await readFile(join(target, 'keep.go'), 'utf8'), 'package main');
});
