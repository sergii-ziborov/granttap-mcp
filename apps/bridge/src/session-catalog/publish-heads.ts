import type { RelayClient } from "../../../../packages/core/relay-client";
import type { SessionsStatus } from "../../../../packages/protocol/schema";

type HeadRun = { running: boolean; closed: boolean };
const runs = new WeakMap<RelayClient, HeadRun>();

/** Transcript transfers must never occupy the fresh catalog's publication slot. */
export function publishCatalogHeads(client: RelayClient, status: SessionsStatus,
  subscriptions: ReadonlySet<string>,
  publish: (client: RelayClient, sessionId: string, status: SessionsStatus) => Promise<unknown>): void {
  const state = runs.get(client) ?? { running: false, closed: false };
  runs.set(client, state);
  if (state.running || state.closed || subscriptions.size === 0) return;
  state.running = true;
  void (async () => {
    for (const sessionId of [...subscriptions]) {
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
