import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { readRepositoryGit } from '../../../../mesh/catalog';

const cached = new Map<string, { at: number; value?: string }>();
const pending = new Map<string, Promise<string | undefined>>();

function changedPaths(status: string): string[] | undefined {
  const fields = status.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    if (!field) continue;
    if (field.length < 4 || field[2] !== ' ') return undefined;
    paths.push(field.slice(3));
    if (/[RC]/.test(field.slice(0, 2))) {
      const previous = fields[++index];
      if (!previous) return undefined;
      paths.push(previous);
    }
    if (paths.length > 4096) return undefined;
  }
  return [...new Set(paths)].sort();
}

async function capture(root: string, revision?: string): Promise<string | undefined> {
  try {
    const directory = await realpath(root);
    const status = await readRepositoryGit(directory,
      ['status', '--porcelain=v1', '--untracked-files=all', '-z'], { timeoutMs: 5_000, maxBuffer: 4 * 1024 * 1024 });
    if (status === undefined) return undefined;
    const paths = changedPaths(status);
    if (!paths) return undefined;
    const hash = createHash('sha256').update(JSON.stringify([directory, revision])).update(status);
    for (let start = 0; start < paths.length; start += 16) {
      const rows = await Promise.all(paths.slice(start, start + 16).map(async path => {
        const absolute = resolve(directory, path);
        if (isAbsolute(path) || !absolute.startsWith(directory + sep)) throw new Error('Invalid repository path');
        try {
          const stat = await lstat(absolute, { bigint: true });
          return [path, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].map(String);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [path, 'missing'];
          throw error;
        }
      }));
      hash.update(JSON.stringify(rows));
    }
    return hash.digest('hex');
  } catch { return undefined; }
}

/** Observe committed and uncommitted source without parsing it or executing a build. */
export function repositorySourceFingerprint(root: string, revision?: string,
  options: { fresh?: boolean } = {}): Promise<string | undefined> {
  const key = JSON.stringify([root, revision]), previous = cached.get(key), now = Date.now();
  if (!options.fresh && previous && now >= previous.at && now - previous.at < 5_000) {
    return Promise.resolve(previous.value);
  }
  const active = pending.get(key);
  if (!options.fresh && active) return active;
  const next = capture(root, revision).then(value => {
    if (pending.get(key) === next) {
      cached.delete(key);
      if (cached.size >= 128) cached.delete(cached.keys().next().value!);
      cached.set(key, { value, at: Date.now() });
    }
    return value;
  }).finally(() => { if (pending.get(key) === next) pending.delete(key); });
  pending.set(key, next);
  return next;
}
