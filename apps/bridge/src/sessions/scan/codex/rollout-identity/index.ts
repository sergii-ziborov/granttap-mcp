import { statSync } from 'node:fs';
import { safeParse } from '../../../support/common';

type Identity = { signature: string; sessionId: string };

function signature(file: string): string {
  const stat = statSync(file, { bigint: true });
  if (!stat.isFile()) throw Error('A rollout must be a regular file');
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

/** Index bounded metadata, never another conversation's large activity window. */
export function createCodexRolloutIdentityLookup(readMetadata: (file: string) => string[]) {
  const cache = new Map<string, Identity>();
  return (sessionId: string, files: string[]): string | undefined => {
    for (const file of files) {
      try {
        const before = signature(file);
        let identity = cache.get(file);
        if (!identity || identity.signature !== before) {
          const line = readMetadata(file).find(row => safeParse(row)?.type === 'session_meta');
          const meta = line ? safeParse(line) : undefined;
          if (signature(file) !== before) { cache.delete(file); continue; }
          identity = { signature: before, sessionId: String(meta?.payload?.id ?? meta?.id ?? '') };
          cache.delete(file);
          if (cache.size >= 256) cache.delete(cache.keys().next().value!);
          cache.set(file, identity);
        }
        if (identity.sessionId && identity.sessionId === sessionId) return file;
      } catch {
        cache.delete(file);
      }
    }
    return undefined;
  };
}
