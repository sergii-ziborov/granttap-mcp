import { createHash } from 'node:crypto';
import type { SessionsStatus } from '../../../../packages/protocol/schema';

export type TaskActivitySnapshot = {version: 1; keyId: string; machine: string; taskCount: number;
  generatedAt: number; rows: {id: string; title: string; preview: string; state: string; lastActivityAt: number}[]};

function text(value: string | undefined, bytes: number): string {
  let result = '';
  for (const point of (value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()) {
    if (Buffer.byteLength(result + point) > bytes) break;
    result += point;
  }
  return result;
}

/** The root catalog already owns child exclusion. Executions of one Task share one row. */
export function taskActivitySnapshot(catalog: SessionsStatus,
  options: {keyId: string; previews: boolean}): TaskActivitySnapshot {
  const tasks = new Map<string, SessionsStatus['sessions'][number]>();
  for (const session of catalog.sessions) {
    const key = session.projectId && session.taskId
      ? `${session.projectId}\0${session.taskId}` : session.sessionId;
    if ((tasks.get(key)?.lastActivityAt ?? -Infinity) < session.lastActivityAt) tasks.set(key, session);
  }
  const sorted = [...tasks].sort(([a, left], [b, right]) =>
    right.lastActivityAt - left.lastActivityAt || a.localeCompare(b));
  return {version: 1, keyId: options.keyId, machine: options.previews ? text(catalog.machine, 128) : 'GrantTap',
    taskCount: tasks.size, generatedAt: catalog.generatedAt,
    rows: options.previews ? sorted.slice(0, 2).map(([id, item]) => ({
      id: createHash('sha256').update(id).digest('hex').slice(0, 24),
      title: text(item.title, 128) || 'GrantTap', preview: text(item.summary, 256),
      state: item.state, lastActivityAt: item.lastActivityAt,
    })) : []};
}
