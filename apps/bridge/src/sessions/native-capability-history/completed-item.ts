import type { SessionInfo } from '../../../../../packages/protocol/schema';
import type { CapabilityObservation } from '../telemetry';
import { ts } from '../support/common';

/** Only host-authored execution records establish inner Code Mode calls. */
export function completedCodexMcp(row: any, session: SessionInfo): CapabilityObservation | undefined {
  const payload = row?.payload;
  if (row?.type !== 'event_msg' || payload?.type !== 'item_completed'
    || (payload.thread_id != null && payload.thread_id !== session.sessionId)) return;
  const item = payload.item;
  if (!['McpToolCall', 'mcpToolCall'].includes(item?.type)) return;
  if (![item.id, item.server, item.tool].every(x => typeof x === 'string' && x.trim() && x.length <= 240)) return;
  const start = payload.started_at_ms ?? ts(row.timestamp) ?? session.lastActivityAt;
  const elapsed = item.durationMs ?? (item.duration && Number.isFinite(item.duration.secs)
    && Number.isFinite(item.duration.nanos) ? item.duration.secs * 1000 + item.duration.nanos / 1e6
      : payload.completed_at_ms != null ? payload.completed_at_ms - start : undefined);
  const outcome = item.status === 'failed' || item.result?.isError === true || item.result?.is_error === true
    ? 'error' : ['cancelled', 'canceled'].includes(item.status) ? 'cancelled'
      : item.status === 'completed' ? 'success' : 'unknown';
  return { sourceId: `${session.sessionId}:${item.id}`, sessionId: session.sessionId,
    toolName: `mcp__${item.server}__${item.tool}`, mcpServer: item.server, createdAt: start,
    outcome, ...(Number.isFinite(elapsed) && elapsed >= 0
      ? { durationMs: Math.min(3600000, Math.round(elapsed)) } : {}) };
}

export function recordedCodexToolName(payload: any): string {
  const name = String(payload.name ?? payload.type);
  const namespace = payload.namespace;
  return typeof namespace === 'string' && /^mcp__[A-Za-z0-9_-]+$/.test(namespace)
    ? `${namespace}__${name}` : name;
}
