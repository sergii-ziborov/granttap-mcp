import { setImmediate } from "node:timers/promises";
import type { RelayClient } from "../../../../../packages/core/relay-client";
import type { SessionInfo, SessionsStatus } from "../../../../../packages/protocol/schema";
import { scanCapabilityUsage, scopeCapabilityUsageToRoom } from "../../sessions";

type Publication = { running: boolean; closed: boolean; lastPublishedAt: number };
const publications = new WeakMap<RelayClient, Publication>();

/** A slow usage fan-out never occupies the current chat catalog's publication slot. */
export function publishMonitorCapabilities(client: RelayClient, status: SessionsStatus,
  history: () => Promise<SessionInfo[]>): void {
  const state = publications.get(client) ?? { running: false, closed: false, lastPublishedAt: 0 };
  publications.set(client, state);
  if (state.running || state.closed || Date.now() - state.lastPublishedAt < 30_000) return;
  state.running = true;
  const work = (async () => {
    await setImmediate();
    if (state.closed || !client.isConnected) return;
    const older = await history();
    if (state.closed || !client.isConnected) return;
    const usage = scanCapabilityUsage([...status.sessions, ...older]);
    await client.send(scopeCapabilityUsageToRoom(usage, client.room), "phone",
      { ttlMs: 90_000, reliable: false });
    state.lastPublishedAt = Date.now();
  })();
  void work.catch(() => {}).finally(() => { state.running = false; });
}

export function stopMonitorCapabilities(client: RelayClient): void {
  const state = publications.get(client);
  if (state) state.closed = true;
  publications.delete(client);
}
