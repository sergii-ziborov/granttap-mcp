import type { RelayClient } from "../../../../packages/core/relay-client";
import type { SessionsStatus } from "../../../../packages/protocol/schema";

type HeadRun = { running: boolean; closed: boolean; cursor: number };
const runs = new WeakMap<RelayClient, HeadRun>();

/** Transcript transfers must never occupy the fresh catalog's publication slot. */
export function publishCatalogHeads(client: RelayClient, status: SessionsStatus,
  subscriptions: ReadonlySet<string>,
  publish: (client: RelayClient, sessionId: string, status: SessionsStatus) => Promise<unknown>): void {
  const state = runs.get(client) ?? { running: false, closed: false, cursor: 0 };
  runs.set(client, state);
  if (state.running || state.closed) return;
  const candidates = [...new Set([...subscriptions,
    ...(client.supportsRetainedState ? status.sessions.map(session => session.sessionId) : [])])];
  if (!candidates.length) return;
  const count = Math.min(32, candidates.length);
  const selected = Array.from({ length: count }, (_, offset) => candidates[(state.cursor + offset) % candidates.length]!);
  state.cursor = (state.cursor + count) % candidates.length;
  state.running = true;
  void (async () => {
    for (const sessionId of selected) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (state.closed || !client.isConnected) break;
      await publish(client, sessionId, status).catch(() => {});
    }
  })().finally(() => { state.running = false; });
}

export function stopCatalogHeads(client: RelayClient): void {
  const state = runs.get(client);
  if (state) state.closed = true;
}
