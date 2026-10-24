import type { RelayClient } from '../../../../../../packages/core/relay-client';
import type { MeshEvent } from '../../../../../../packages/protocol/schema';
import type { MeshRuntimeDependencies } from '../dependencies';
import { createHandoffFlow } from '../handoff';
import { preparedHandoffMetadata } from '.';

/** Commit the local destination before phone publication can wait on a socket. */
export async function prepareLocalHandoff(deps: MeshRuntimeDependencies, client: RelayClient,
  event: MeshEvent): Promise<boolean> {
  const notifications: Parameters<MeshRuntimeDependencies['send']>[] = [];
  const flow = createHandoffFlow({ ...deps, send: async (...notification) => { notifications.push(notification); } });
  await flow.acceptHandoff(client, event);
  const accepted = notifications.some(([, payload]) => payload.type === 'mesh.event'
    && payload.eventType === 'HANDOFF_ACCEPTED');
  const request: Parameters<MeshRuntimeDependencies['send']> = [client, preparedHandoffMetadata(event),
    { ttlMs: 60 * 60_000, wake: true }];
  for (const notification of [request, ...notifications]) {
    // Both events are durable already. A transport error cannot undo the
    // prepared chat or trigger a second preparation; retained snapshots recover it.
    try { await deps.send(...notification); } catch { /* next connection publishes durable state */ }
  }
  return accepted;
}
