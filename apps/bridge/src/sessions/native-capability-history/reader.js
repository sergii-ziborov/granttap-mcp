import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

const LIMIT = 20000;
const MAX_DURATION = 60 * 60_000;
const validName = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 160;

function outcome(row) {
  if (row.status === 'failed' || row.resultError === 1) return 'error';
  if (row.status === 'cancelled' || row.status === 'canceled') return 'cancelled';
  return row.status === 'completed' ? 'success' : 'unknown';
}

function observe(row, sessionId, now) {
  if (!validName(row.server) || !validName(row.tool) || typeof row.item_id !== 'string') return;
  const createdAt = Number(row.started_at_ms ?? row.created_at_ms);
  if (!Number.isFinite(createdAt) || createdAt <= 0 || createdAt > now + 300000) return;
  const duration = row.durationMs ?? (row.completed_at_ms != null && row.started_at_ms != null
    ? row.completed_at_ms - row.started_at_ms : undefined);
  return { sourceId: `${row.thread_id}:${row.item_id}`.slice(0, 512), sessionId,
    agent: 'codex', kind: 'mcp', name: row.server.trim(),
    toolName: `mcp__${row.server.trim()}__${row.tool.trim()}`.slice(0, 240), createdAt,
    outcome: outcome(row), ...(Number.isFinite(duration) && duration >= 0
      ? { durationMs: Math.min(MAX_DURATION, Math.round(duration)) } : {}) };
}

function readThread(db, { threadId, previous, watermark, now, limit }) {
  const valid = previous && previous.watermark <= watermark;
  const cached = new Map((valid ? previous.events : []).filter(event => event.createdAt >= now - 30 * 86400000)
    .map(event => [event.sourceId, event]));
  if (valid && previous.watermark === watermark) return [...cached.values()].slice(0, limit);
  // The provider's own updated-page index bounds subsequent reads to new or
  // completed calls. Never add an index or write to the provider database.
  const rows = db.prepare(`SELECT thread_id,item_id,created_at_ms,started_at_ms,completed_at_ms,
    json_extract(item_json,'$.server') AS server,json_extract(item_json,'$.tool') AS tool,
    json_extract(item_json,'$.status') AS status,json_extract(item_json,'$.durationMs') AS durationMs,
    json_extract(item_json,'$.result.isError') AS resultError
    FROM thread_items WHERE thread_id=? AND updated_at_ordinal>=? AND item_type='mcpToolCall'
    AND created_at_ms>=? AND length(CAST(item_json AS BLOB))<=262144 AND json_valid(item_json)
    ORDER BY updated_at_ordinal DESC LIMIT ${limit}`)
    .all(threadId, valid ? previous.watermark : 0, now - 30 * 86400000);
  for (const row of rows) {
    const event = observe(row, threadId, now);
    if (event) cached.set(event.sourceId, event);
  }
  return [...cached.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

function readHistory({ database, bindings, now, previous = [] }) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=30;');
    const owners = new Map(bindings);
    const ids = [...owners.keys()];
    const placeholders = ids.map(() => '?').join(',');
    const projections = db.prepare(`SELECT thread_id,next_rollout_ordinal FROM thread_history_projection_state
      WHERE thread_id IN (${placeholders})`).all(...ids);
    const scopes = [...new Set(projections.map(row => owners.get(row.thread_id)))];
    // Large tool results are excluded before JSON extraction. Neither prompts,
    // tool arguments nor result contents cross the worker boundary.
    const old = new Map(previous.map(cursor => [cursor.threadId, cursor]));
    const next = [];
    let remaining = LIMIT;
    for (const row of projections.sort((a, b) => ids.indexOf(a.thread_id) - ids.indexOf(b.thread_id))) {
      if (remaining <= 0) break;
      const events = readThread(db, { threadId: row.thread_id, previous: old.get(row.thread_id),
        watermark: row.next_rollout_ordinal, now, limit: remaining });
      next.push({ threadId: row.thread_id, watermark: row.next_rollout_ordinal, events });
      remaining -= events.length;
    }
    const events = next.flatMap(cursor => cursor.events.map(event => ({ ...event,
      sessionId: owners.get(cursor.threadId) }))).sort((a, b) => b.createdAt - a.createdAt).slice(0, LIMIT);
    const summaries = new Map();
    for (const event of events) {
      const sessionId = event.sessionId;
      const key = JSON.stringify([sessionId, event.name]);
      const summary = summaries.get(key) ?? { sessionId, agent: 'codex', kind: 'mcp',
        name: event.name, count: 0, failures: 0, cancelled: 0, lastUsedAt: 0,
        source: 'native-history' };
      summary.count++;
      summary.failures += event.outcome === 'error' ? 1 : 0;
      summary.cancelled += event.outcome === 'cancelled' ? 1 : 0;
      summary.lastUsedAt = Math.max(summary.lastUsedAt, event.createdAt);
      if (event.durationMs != null) {
        summary.durationMs = (summary.durationMs ?? 0) + event.durationMs;
        summary.durationCount = (summary.durationCount ?? 0) + 1;
      }
      summaries.set(key, summary);
    }
    return { scopes, events, cursors: next, summaries: [...summaries.values()]
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, 128) };
  } finally { db.close(); }
}

try { parentPort.postMessage(readHistory(workerData)); }
catch { parentPort.postMessage({ scopes: [], events: [], summaries: [] }); }
parentPort.close();
