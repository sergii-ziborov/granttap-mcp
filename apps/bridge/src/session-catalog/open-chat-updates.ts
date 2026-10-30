import type {SessionInfo, SessionsStatus} from '../../../../packages/protocol/schema';
import {observeSessionExecution, type SessionObservation} from './observed-state';

export const OPEN_CHAT_INTERVAL_MS = 2_000;

/** Follow known native files independently of discovery, without rereading unchanged heads. */
export function openChatUpdates(options: {
  catalog: () => SessionsStatus | undefined;
  subscriptions: ReadonlySet<string>;
  active: () => boolean;
  publish: (sessionId: string, status: SessionsStatus) => Promise<boolean>;
  observe?: (session: SessionInfo) => SessionObservation | undefined;
}): () => Promise<void> {
  const revisions = new Map<string, string>();
  const observe = options.observe ?? observeSessionExecution;
  let cursor = 0, openCursor = 0, running = false;
  return async () => {
    if (running || !options.active()) return;
    const status = options.catalog();
    if (!status) return;
    const known = new Map([...status.sessions, ...(status.history ?? [])]
      .map(session => [session.sessionId, session]));
    const ids = [...new Set([...options.subscriptions,
      ...status.sessions.filter(session => session.state === 'working').map(session => session.sessionId)])]
      .filter(id => known.has(id));
    const activeIds = new Set(ids);
    for (const id of revisions.keys()) if (!activeIds.has(id)) revisions.delete(id);
    if (!ids.length) return;
    const opened = ids.filter(id => options.subscriptions.has(id));
    const background = ids.filter(id => !options.subscriptions.has(id));
    const selected = Array.from({length: Math.min(8, opened.length)}, (_, offset) => opened[(openCursor + offset) % opened.length]!);
    openCursor = opened.length ? (openCursor + selected.length) % opened.length : 0;
    const remaining = Math.min(8 - selected.length, background.length);
    selected.push(...Array.from({length: remaining}, (_, offset) => background[(cursor + offset) % background.length]!));
    cursor = background.length ? (cursor + remaining) % background.length : 0;
    running = true;
    try {
      for (const id of selected) {
        await new Promise<void>(resolve => setImmediate(resolve));
        if (!options.active()) break;
        let observed: SessionObservation | undefined;
        try { observed = observe(known.get(id)!); } catch { continue; }
        if (!observed || revisions.get(id) === observed.revision) continue;
        // Keep the full catalog's clock: one fresh chat cannot refresh unrelated chats.
        const fresh = {...status, sessions: [observed.session], history: undefined};
        try {
          if (await options.publish(id, fresh)) revisions.set(id, observed.revision);
        } catch { /* Retry the same revision after a failed encrypted send. */ }
      }
    } finally { running = false; }
  };
}
