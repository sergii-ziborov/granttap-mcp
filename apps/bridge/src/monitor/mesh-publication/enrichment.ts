import type { MeshSnapshot } from '../../../../../packages/protocol/schema';
import { enrichMeshSnapshot } from '../../mesh/runtime/snapshot/enriched';
/** Publish ready Projects independently so one slow binding cannot hold other reports. */
export async function publishEnrichedMeshes(snapshots: MeshSnapshot[], send: (snapshot: MeshSnapshot) => Promise<void>, enrich: typeof enrichMeshSnapshot = enrichMeshSnapshot): Promise<void> {
    await Promise.all(snapshots.map(async (snapshot) => {
        try {
            await send(await enrich(snapshot));
        }
        catch { /* This Project is retried on the next publication tick. */ }
    }));
}
