import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** No file contents or database internals are read; symlinks cannot be cleaned. */
export async function storageFingerprint(path: string): Promise<string> {
  const digest = createHash('sha256');
  let visited = 0;
  async function visit(current: string, depth: number): Promise<void> {
    if (++visited > 20_000 || depth > 16) throw new Error('Storage scan capped');
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error('Protected storage');
    digest.update(JSON.stringify([current, stat.ino, stat.dev, stat.size, stat.mtimeMs, stat.ctimeMs]));
    if (!stat.isDirectory()) return;
    for (const name of (await readdir(current)).sort()) await visit(join(current, name), depth + 1);
  }
  await visit(path, 0);
  return digest.digest('hex');
}
