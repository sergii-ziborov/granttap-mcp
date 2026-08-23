import { RelayClient } from "../../../../packages/core/relay-client";
import type { MeshEvent, Payload } from "../../../../packages/protocol/schema";
import {
  applyGrokBotPolicy,
  authorizeGrokBotOperation,
  loadGrokBotEndpoint,
} from "../../../bridge/src/mesh/endpoint";
import { localMeshStore } from "../../../bridge/src/mesh/local";

let client: RelayClient | null = null;
let credentialId: string | null = null;

function acceptsProject(projectId: string): boolean {
  const bundle = loadGrokBotEndpoint();
  return bundle?.policy.enabled === true
    && bundle.policy.status === "active"
    && bundle.policy.projectIds.includes(projectId);
}

function receive(payload: Payload): boolean {
  if (payload.type === "mesh.endpoint.policy") {
    applyGrokBotPolicy(payload);
    if (payload.status === "revoked") resetGrokBotRelay();
    return true;
  }
  if (payload.type === "mesh.snapshot" && acceptsProject(payload.projectId)) {
    localMeshStore().mergeSnapshot(payload);
    return true;
  }
  if (payload.type === "mesh.event" && acceptsProject(payload.projectId)) {
    return localMeshStore().acceptEvent(payload);
  }
  return false;
}

export async function grokBotRelay(): Promise<RelayClient> {
  const bundle = loadGrokBotEndpoint();
  if (!bundle) throw new Error("Grok Bot endpoint is not connected");
  authorizeGrokBotOperation({
    actorId: bundle.actors.find((actor) => actor.enabled)?.actorId ?? "",
    projectId: bundle.policy.projectIds[0] ?? "",
    operation: "status",
  });
  if (!client || credentialId !== bundle.credential.credentialId) {
    client?.close();
    client = new RelayClient(bundle.pairing, { autoReconnect: true });
    credentialId = bundle.credential.credentialId;
    client.onMessage(receive);
  }
  await client.connect();
  return client;
}

export async function publishGrokBotEvent(event: MeshEvent): Promise<void> {
  const relay = await grokBotRelay();
  await relay.sendSession(event, event.taskId, "phone", {
    ttlMs: Math.max(30_000, (event.expiresAt ?? Date.now() + 3_600_000) - Date.now()),
    wake: event.payload.needsUser || undefined,
  });
}

export function resetGrokBotRelay(): void {
  client?.close();
  client = null;
  credentialId = null;
}
