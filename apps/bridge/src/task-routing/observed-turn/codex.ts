import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { SessionInfo } from '../../../../../packages/protocol/schema';

type Controls = { model: string; effort: SessionInfo['effort'] };
const MAX_LINE = 512 * 1_024, CHUNK = 64 * 1_024, MAX_SCAN = 64 * 1_024 * 1_024;

/** Only invoked for an explicit offload, independently of the cheap catalog head/tail window. */
export async function readLatestCodexTurnControls(path: string, maxBytes = MAX_SCAN): Promise<Controls | undefined> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return undefined;
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const initial = await file.stat();
    if (!initial.isFile()) return undefined;
    let position = initial.size, read = 0, tail = Buffer.alloc(0), dropping = false;
    let found: Controls | undefined;
    while (position > 0 && read < Math.min(maxBytes, MAX_SCAN) && !found) {
      const length = Math.min(CHUNK, position, Math.min(maxBytes, MAX_SCAN) - read);
      position -= length; read += length;
      const chunk = Buffer.allocUnsafe(length);
      if ((await file.read(chunk, 0, length, position)).bytesRead !== length) return undefined;
      let end = length;
      for (let index = chunk.lastIndexOf(10, end - 1); index >= 0; index = chunk.lastIndexOf(10, end - 1)) {
        const segment = chunk.subarray(index + 1, end);
        if (!dropping && segment.length + tail.length <= MAX_LINE) found = controls(Buffer.concat([segment, tail]));
        tail = Buffer.alloc(0); dropping = false; end = index;
        if (found || end === 0) break;
      }
      if (!dropping && end + tail.length <= MAX_LINE) tail = Buffer.concat([chunk.subarray(0, end), tail]);
      else { tail = Buffer.alloc(0); dropping = true; }
    }
    if (!found && position === 0 && !dropping) found = controls(tail);
    const final = await file.stat();
    return final.size === initial.size && final.mtimeMs === initial.mtimeMs ? found : undefined;
  } finally { await file.close(); }
}

function controls(line: Buffer): Controls | undefined {
  if (!line.length || !line.includes('"turn_context"')) return undefined;
  try {
    const row = JSON.parse(line.toString('utf8'));
    if (row.type !== 'turn_context' || typeof row.payload?.model !== 'string'
      || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(row.payload.model)) return undefined;
    const effort = row.payload.effort ?? row.payload.reasoning_effort;
    return { model: row.payload.model,
      effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort) ? effort : undefined };
  } catch { return undefined; }
}
