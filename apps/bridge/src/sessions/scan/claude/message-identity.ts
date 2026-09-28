import { createHash } from 'node:crypto';

/** Host UUIDs remain stable when a JSONL window starts at a different row. */
export function claudeMessageIdentity(sessionId: string, row: unknown, line: string, block = 0): string {
  const uuid = (row as { uuid?: unknown })?.uuid;
  const identity = typeof uuid === 'string' && uuid.length <= 256 ? uuid : line;
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  return `${sessionId}:message:${hash}:${block}`;
}
