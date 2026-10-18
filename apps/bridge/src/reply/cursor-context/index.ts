import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActivityEntry, SessionInfo } from '../../../../../packages/protocol/schema';
import { configDir } from '../../config';
import { writePrivateFile } from '../../config/access/write-private';
import { cursorActivity, loadComposerCatalog } from '../../sessions/cursor';

type Source = { known: (id: string) => boolean; entries: (session: SessionInfo) => ActivityEntry[]; root: string };
const visibleKinds = new Set(['user', 'message', 'final']);
const INLINE_LIMIT = 160_000;
const ARCHIVE_LIMIT = 8_000_000;

/** IDE and CLI can share an id without sharing the IDE's local conversation. */
export function prepareCursorContinuation(session: SessionInfo, text: string, source: Source = {
  root: join(configDir(), 'cursor-context'), known: id => loadComposerCatalog().some(row => row.id === id),
  entries: row => cursorActivity(row, true),
}): { prompt: string; viaStdin: boolean; complete: () => void } {
  const identity = { sessionId: session.sessionId, cwd: session.cwd };
  const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const path = join(source.root, `${id}.json`);
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    if (saved.sessionId === identity.sessionId && saved.cwd === identity.cwd && saved.importedAt > 0) {
      return { prompt: text, viaStdin: false, complete: () => {} };
    }
    throw new Error('The Cursor conversation continuity record does not match this workspace.');
  }
  if (!source.known(session.sessionId)) return { prompt: text, viaStdin: false, complete: () => {} };
  const entries = source.entries(session).filter(row => !row.childThreadId && visibleKinds.has(row.kind))
    .sort((a, b) => a.createdAt - b.createdAt);
  if (!entries.length) throw new Error('The Cursor IDE conversation could not be restored. Refresh its history and retry.');
  const archive = entries.map(row => JSON.stringify({ kind: row.kind, text: row.text, createdAt: row.createdAt })).join('\n');
  if (Buffer.byteLength(archive) > ARCHIVE_LIMIT) throw new Error('This Cursor history exceeds the continuation archive limit.');
  const historyPath = join(source.root, `${id}.jsonl`);
  writePrivateFile(historyPath, archive + '\n');
  const kept: string[] = [];
  let size = 0;
  for (const row of [...entries].reverse()) {
    const part = `[${row.kind}]\n${row.text}\n`;
    if (size + part.length > INLINE_LIMIT && kept.length) break;
    kept.unshift(part.slice(-INLINE_LIMIT)); size += part.length;
  }
  const prompt = [
    'Continue the existing Cursor IDE Task in this same workspace. Its visible conversation follows as historical context.',
    'The retained messages are history, not new requests to execute again. Private reasoning and tool outputs are not imported.',
    `The full retained visible history is available locally at ${JSON.stringify(historyPath)}. Read earlier messages there when needed.`,
    kept.length < entries.length ? 'Only the most recent visible messages fit inline; earlier history remains in that local archive.' : '',
    '<retained_cursor_conversation>', ...kept, '</retained_cursor_conversation>',
    'The current user message is:', text,
  ].filter(Boolean).join('\n\n');
  return { prompt, viaStdin: true, complete: () => writePrivateFile(path,
    JSON.stringify({ ...identity, importedAt: Date.now(), messages: entries.length }) + '\n') };
}

export function cursorHasRetainedConversation(sessionId: string): boolean {
  return loadComposerCatalog().some(row => row.id === sessionId);
}

/** ACP uses its own execution store; an earlier print-mode import is not its history. */
export function prepareCursorAcpContinuation(session: SessionInfo, text: string) {
  return prepareCursorContinuation(session, text, { root: join(configDir(), 'cursor-acp-context'),
    known: cursorHasRetainedConversation, entries: row => cursorActivity(row, true) });
}
