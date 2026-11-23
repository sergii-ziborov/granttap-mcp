import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

/** Folder → the checkout above it, or null when none is; shared by every file under it. */
const checkouts = new Map<string, string | null>();

/**
 * The Git checkout (a repository or a worktree, whose `.git` is a file) a
 * changed file belongs to, or else the folder it is in. Agents edit other
 * worktrees than the chat's own, and a list grouped by checkout stays readable.
 */
export function changeFolder(path: string): string | undefined {
  if (!isAbsolute(path)) return undefined;
  const visited: string[] = [];
  let found: string | null = null;
  for (let folder = dirname(path); visited.length < 64; folder = dirname(folder)) {
    const known = checkouts.get(folder);
    if (known !== undefined) { found = known; break; }
    visited.push(folder);
    if (existsSync(join(folder, '.git'))) { found = folder; break; }
    if (dirname(folder) === folder) break;
  }
  if (checkouts.size > 4096) checkouts.clear();
  for (const folder of visited) checkouts.set(folder, found);
  return (found ?? removedFolder(path) ?? dirname(path)).slice(0, 2048);
}

/** A worktree removed since its agent finished: the top folder that is gone groups its files. */
function removedFolder(path: string): string | undefined {
  let top: string | undefined;
  for (let folder = dirname(path); dirname(folder) !== folder && !existsSync(folder); folder = dirname(folder)) top = folder;
  return top;
}

/** A recorded file with the folder it is listed under. */
export function withFolder<T extends { path: string; folder?: string }>(file: T): T {
  if (file.folder) return file;
  const folder = changeFolder(file.path);
  return folder ? { ...file, folder } : file;
}
