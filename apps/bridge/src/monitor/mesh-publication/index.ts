import type { RelayClient } from "../../../../../packages/core/relay-client";
import type { SessionsStatus } from "../../../../../packages/protocol/schema";
import { localMeshStore } from "../../mesh/local-remote/local";
import { meshSnapshotsAsync } from "../../mesh/runtime";
import { publishEnrichedMeshes } from "./enrichment";
import { deriveObservedClaims } from "../../mesh/observed/claims";
import { ingestRuntimeInvocations } from "../../engine/invocation/ingest";
import { publishProjectPolicyStatuses } from "../../project-policy/runtime";
import { publishedCatalog } from "../../session-catalog";
import { sendMeshPayload } from "../../host/session-keys";
import { INTERVAL_MS } from "../handlers/catalog";

const pending = new WeakMap<RelayClient, { active: boolean }>();

/** One background projection per transport; it never holds the current chat catalog. */
export function publishMonitorMeshes(client: RelayClient, status: SessionsStatus): void {
  if (pending.has(client)) return;
  const token = { active: true };
  pending.set(client, token);
  const work = (async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    if (!token.active || !client.isConnected) return;
    deriveObservedClaims(localMeshStore(), status.sessions);
    void ingestRuntimeInvocations(status.sessions).catch(() => {});
    const known = publishedCatalog(client);
    const snapshots = await meshSnapshotsAsync([...status.sessions, ...(known?.history ?? [])]);
    for (const snapshot of snapshots) {
      if (!token.active || !client.isConnected) return;
      await sendMeshPayload(client, snapshot, "phone", { ttlMs: INTERVAL_MS * 24, reliable: false }).catch(() => {});
    }
    if (!token.active || !client.isConnected) return;
    await publishProjectPolicyStatuses(client, snapshots.map(mesh => mesh.projectId)).catch(() => {});
    await publishEnrichedMeshes(snapshots, async snapshot => {
      if (!token.active || !client.isConnected) return;
      await sendMeshPayload(client, snapshot, "phone", { ttlMs: INTERVAL_MS * 24, reliable: false }).catch(() => {});
    });
  })();
  void work.catch(() => {}).finally(() => { if (pending.get(client) === token) pending.delete(client); });
}

export function stopMonitorMeshes(client: RelayClient): void {
  const token = pending.get(client);
  if (token) token.active = false;
  pending.delete(client);
}
