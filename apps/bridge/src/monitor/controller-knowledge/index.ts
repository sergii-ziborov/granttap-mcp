import type { RelayClient } from "../../../../../packages/core/relay-client";
import type { ControllerPairRequest, KnowledgeWrite } from "../../../../../packages/protocol/schema";
import { loadRuntimeConfig } from "../../config";
import { loadConfig, machineConfigPath } from "../../config";
import { localMeshStore } from "../../mesh/local-remote/local";
import { createOneTimePairing, parkedPairingHalves } from "../../pairing";
import { issueControllerOffer } from "../../pairing/controller-invites";
import { handleKnowledgeWrite } from "../../mesh/knowledge/write";
import { recordProjectKnowledge } from "../../engine/runtime/engine-memory";
import { computerId } from "../../mesh/identity/computer";

/** The requester's device key scopes the new controller code, not Project access. */
export async function handleControllerPairRequest(
  client: RelayClient, request: ControllerPairRequest, peerPublicKey?: string,
): Promise<boolean> {
  if (!peerPublicKey || !parkedPairingHalves()) return false;
  const machine = loadConfig(machineConfigPath());
  if (machine.room !== client.room) return false;
  return issueControllerOffer(client, peerPublicKey, request, async () => {
    const pairing = await createOneTimePairing(machine.relayUrl, {
      installHooks: false, addController: true,
    });
    return { room: pairing.machineCfg.room, peerPublicKey: pairing.phoneCfg.myPublicKey,
      uri: pairing.qrPayload };
  });
}

/** A phone gets a recorded receipt only after the local Engine commits Memory. */
export async function handleInboundKnowledgeWrite(
  client: RelayClient, request: KnowledgeWrite, peerPublicKey: string | undefined,
  publish: () => Promise<void>,
): Promise<boolean> {
  if (!peerPublicKey) return false;
  const endpointId = computerId();
  let recorded = false;
  const handled = await handleKnowledgeWrite(request, {
    now: Date.now, endpointId,
    snapshot: (projectId) => {
      if (!loadRuntimeConfig().meshEnabled) return undefined;
      const snapshot = localMeshStore().snapshot(projectId, endpointId);
      return snapshot && { tasks: snapshot.tasks, bindings: snapshot.bindings ?? [] };
    },
    record: async (entry) => {
      recorded = await recordProjectKnowledge(entry);
      return recorded;
    },
    send: (result) => client.sendToPeer(result, peerPublicKey),
  });
  if (recorded) void publish().catch(() => {});
  return handled;
}
