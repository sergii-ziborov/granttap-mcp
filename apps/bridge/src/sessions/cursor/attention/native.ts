import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ActivityEntry, SessionInfo } from '../../../../../../packages/protocol/schema';
import { cursorQuestionText, cursorNoticeText } from './presentation';

type NativeRow = { id: string; at?: string | number; name?: string; params?: unknown; warning?: unknown };
const sql = (value: string) => "'" + value.replaceAll("'", "''") + "'";

function decoded(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return undefined; }
}

/** Exact indexed composer/bubble reads. No database scan and no writes to Cursor's state. */
export function cursorNativeAttention(session: SessionInfo, db = process.env.GRANTTAP_CURSOR_STATE_DB
  ?? join(homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb')): ActivityEntry[] {
  if (!existsSync(db) || !session.sessionId || session.sessionId.length > 256) return [];
  try {
    const query = `WITH composer AS (SELECT value FROM cursorDiskKV WHERE key=${sql('composerData:' + session.sessionId)}),
      headers AS (SELECT json_extract(j.value,'$.bubbleId') AS id, json_extract(j.value,'$.createdAt') AS at
        FROM composer, json_each(composer.value,'$.fullConversationHeadersOnly') j
        ORDER BY CAST(j.key AS INTEGER) DESC LIMIT 128)
      SELECT h.id, coalesce(json_extract(b.value,'$.createdAt'),h.at) AS at,
        json_extract(b.value,'$.toolFormerData.name') AS name,
        CASE WHEN lower(json_extract(b.value,'$.toolFormerData.name')) IN ('ask_question','askquestion','askuserquestion')
          THEN json_extract(b.value,'$.toolFormerData.params') END AS params,
        coalesce(json_extract(b.value,'$.errorDetails.error.details.detail'),
          json_extract(b.value,'$.errorDetails.error.details.title'),
          json_extract(b.value,'$.errorDetails.message'),json_extract(b.value,'$.warning.message')) AS warning
      FROM headers h JOIN cursorDiskKV b ON b.key=${sql('bubbleId:' + session.sessionId + ':')} || h.id;`;
    const raw = execFileSync('sqlite3', ['-readonly', '-json', db, query], {
      encoding: 'utf8', timeout: 1_000, maxBuffer: 2 * 1_024 * 1_024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const rows: NativeRow[] = raw.trim() ? JSON.parse(raw) : [];
    return rows.flatMap(row => {
      const question = cursorQuestionText(row.name, decoded(row.params));
      const notice = cursorNoticeText({ type: 'warning', message: row.warning });
      const text = question ?? notice;
      if (!text || typeof row.id !== 'string' || row.id.length > 256) return [];
      const at = typeof row.at === 'number' ? row.at : Date.parse(row.at ?? '');
      return [{ id: `cursor-attention:${session.sessionId}:${row.id}`,
        kind: question ? 'message' as const : 'status' as const, text,
        createdAt: Number.isFinite(at) ? at : session.lastActivityAt }];
    }).sort((a, b) => a.createdAt - b.createdAt);
  } catch { return []; }
}
