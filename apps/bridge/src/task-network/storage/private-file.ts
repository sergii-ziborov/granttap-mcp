import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { writePrivateFile } from '../../config/access/write-private';

export const networkDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function readNetworkFile(path: string, limit = 24_000_000): unknown {
  if (statSync(path).size > limit) throw new Error('Project network record exceeds its bound.');
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  if (saved.digest !== networkDigest(saved.value)) throw new Error('Project network record is incomplete.');
  return saved.value;
}
export function writeNetworkFile(path: string, value: unknown): void {
  writePrivateFile(path, JSON.stringify({ value, digest: networkDigest(value) }));
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  if (process.platform !== 'win32') {
    const parent = openSync(dirname(path), 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
  }
}
export function networkJobId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/.test(id)) throw new Error('Invalid Project network job identity.');
  return id;
}
