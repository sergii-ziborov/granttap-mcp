import type { SessionInfo } from '../../../../../packages/protocol/schema';
import { codexImageChunk } from '../../sessions/scan/codex/image';
import { codexLogPathForSession, codexLogLines } from '../../sessions/scan/codex/shared';
import { claudeLogPath } from '../../sessions/scan/claude';
import { claudeMessageIdentity } from '../../sessions/scan/claude/message-identity';
import { previousNativeLines } from '../native-lines';

let cached: { key: string; bytes: Buffer; mime: string; until: number } | undefined;

/** Native attachment bytes are located by advertised row identity and cursor. */
export function nativeTranscriptImage(session: SessionInfo, imageId: string, offset: number, cursor?: string) {
  const key = `${session.agent}\0${session.sessionId}\0${imageId}`;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 8 * 1024 * 1024) return undefined;
  if (session.agent === 'codex' && offset > 0) return codexImageChunk(session.sessionId, imageId, offset);
  if (cached?.key === key && cached.until > Date.now()) return slice(cached, offset);
  let path = session.agent === 'claude' ? claudeLogPath(session.sessionId)
    : codexLogPathForSession(session.sessionId, session.startedAt);
  if (!path && session.agent === 'codex') {
    codexLogLines(session.sessionId);
    path = codexLogPathForSession(session.sessionId, session.startedAt);
  }
  if (!path || !['claude', 'codex'].includes(session.agent)) return undefined;
  try {
    const lines = previousNativeLines(path, session.sessionId, cursor)?.lines.map(l => l.text);
    if (!lines) return undefined;
    if (session.agent === 'codex') {
      const full = codexImageChunk(session.sessionId, imageId, 0, lines);
      if (!full) return undefined;
      // The native reader retains the original bytes for subsequent bounded chunks.
      return codexImageChunk(session.sessionId, imageId, offset);
    }
    for (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.type !== 'user' && row.message?.role !== 'user') continue;
      const blocks = row.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const [index, block] of blocks.entries()) {
        if (block?.type !== 'image' || claudeMessageIdentity(session.sessionId, row, line, index) !== imageId) continue;
        const source = block.source;
        if (source?.type !== 'base64' || !['image/png', 'image/jpeg', 'image/webp'].includes(source.media_type)
          || typeof source.data !== 'string' || source.data.length > 11 * 1024 * 1024) return undefined;
        const bytes = Buffer.from(source.data, 'base64');
        if (!bytes.length || bytes.length > 8 * 1024 * 1024) return undefined;
        cached = { key, bytes, mime: source.media_type, until: Date.now() + 30_000 };
        return slice(cached, offset);
      }
    }
  } catch { return undefined; }
  return undefined;
}

function slice(image: { bytes: Buffer; mime: string }, offset: number) {
  if (offset >= image.bytes.length) return undefined;
  return { mime_type: image.mime, total_bytes: image.bytes.length, offset,
    data_base64: image.bytes.subarray(offset, offset + 64 * 1024).toString('base64') };
}
