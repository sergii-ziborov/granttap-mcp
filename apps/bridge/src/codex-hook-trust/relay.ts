import type { RelayClient } from "../../../../packages/core/relay-client";
import type { ProviderHookTrust } from "../../../../packages/protocol/messages/provider-hooks";
import { loadConfig, machineConfigPath } from "../config";
import { observedComputerId } from "../mesh/identity/computer";
import { trustCodexHook } from "./trust";
import { refreshCodexHooks } from "./index";

export async function handleHookTrust(
  client: RelayClient, request: ProviderHookTrust, peerPublicKey: string | undefined,
  publish: () => Promise<void>,
): Promise<boolean> {
  if (!peerPublicKey) return false;
  try {
    const machine = loadConfig(machineConfigPath());
    if (machine.role !== "machine" || machine.room !== client.room
      || (machine.peerPublicKey !== peerPublicKey && !machine.extraPeerPublicKeys?.includes(peerPublicKey))) return false;
    const result = await trustCodexHook(request, observedComputerId());
    if (!result) return false;
    await client.sendToPeer(result, peerPublicKey);
    if (result.ok) await refreshCodexHooks(true);
    void publish().catch(() => {});
    return true;
  } catch { return false; }
}
