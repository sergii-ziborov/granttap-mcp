import { lstat, readdir, rm, mkdir, open, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readState, stableVersion } from '../runtime-updates/selection.mjs';
import { configDir } from '../config/runtime/paths';

type Category = { id: string; name: string; bytes: number; reclaimableBytes: number; paths: string[] };
const exec = promisify(execFile);

async function bytes(path: string): Promise<number> {
  try {
    const s = await lstat(path);
    if (s.isSymbolicLink()) return 0;
    if (!s.isDirectory()) return s.isFile() ? s.size : 0;
    let total = 0;
    for (const name of await readdir(path)) total += await bytes(join(path, name));
    return total;
  } catch { return 0; }
}

/** Only disposable indexes and obsolete immutable runtime packages. Never chats, credentials or projects. */
export async function computerCache(root: string, directory = configDir(), processes?: string): Promise<Category[]> {
  const graph = join(directory, 'repository-graph-cache');
  const graphBytes = await bytes(graph);
  const categories: Category[] = [{ id: 'graph', name: 'Project indexes', bytes: graphBytes, reclaimableBytes: graphBytes, paths: [graph] }];
  const runtimeDirectory = join(directory, 'runtime-updates');
  const state = readState(runtimeDirectory);
  const protectedRoots = [root, state.root, state.previous?.root].filter((v): v is string => typeof v === 'string').map(v => resolve(v));
  // If process inspection is unavailable, retain every runtime rather than guess.
  if (processes == null) {
    try { processes = (await exec('/bin/ps', ['-axo', 'command='], { maxBuffer: 8 * 1024 * 1024, timeout: 3_000 })).stdout; }
    catch { processes = undefined; }
  }
  const runtime: Category = { id: 'runtimes', name: 'Previous MCP downloads', bytes: 0, reclaimableBytes: 0, paths: [] };
  const versions = join(runtimeDirectory, 'versions');
  for (const entry of await readdir(versions, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !stableVersion(entry.name)) continue;
    const path = join(versions, entry.name), packageRoot = join(path, 'node_modules', 'granttap-mcp');
    const size = await bytes(path); runtime.bytes += size;
    if (processes != null && !protectedRoots.includes(resolve(packageRoot)) && !processes.includes(path)) {
      runtime.paths.push(path); runtime.reclaimableBytes += size;
    }
  }
  categories.push(runtime);
  return categories;
}

export async function clearComputerCache(root: string, directory = configDir()): Promise<number> {
  const lockPath = join(directory, 'runtime-updates', 'install.lock');
  await mkdir(join(directory, 'runtime-updates'), { recursive: true, mode: 0o700 });
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch { throw Error('An MCP install or cache cleanup is in progress. Wait for it to finish.'); }
  try { return await removeCaches(root, directory); }
  finally { await lock.close(); await unlink(lockPath); }
}

async function removeCaches(root: string, directory: string): Promise<number> {
  // Re-read selection/process ownership immediately before each deletion.
  const first = await computerCache(root, directory);
  let removed = 0;
  for (const category of first) for (const path of category.paths) {
    const current = await computerCache(root, directory);
    if (!current.some(c => c.paths.includes(path))) continue;
    try {
      if ((await lstat(path)).isSymbolicLink()) continue;
      const size = await bytes(path);
      await rm(path, { recursive: true, force: true }); removed += size;
    } catch { /* A locked cache stays; remaining categories can still be cleared. */ }
  }
  return removed;
}
