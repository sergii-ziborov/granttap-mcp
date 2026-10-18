import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
  })).digest('hex');
}

export function readOrigin(path: string): unknown {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (record.digest !== fingerprint(record.value)) throw new Error('Unreadable task origin');
    return record.value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function writeOrigin(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify({ value, digest: fingerprint(value) })); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    try { unlinkSync(temporary); } catch { /* Rename normally consumed it. */ }
  }
}

export function syncDirectory(path: string): void {
  let fd: number | undefined;
  try { fd = openSync(path, 'r'); fsyncSync(fd); }
  catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
