import { existsSync } from "node:fs";
import { generateKeyPair, randomId, seal } from "../../../../packages/core/crypto";
import { createPairing, DEFAULT_RELAY_URL, machineConfigPath, phonePairingPath,
  saveConfig } from "../config";
import { applyNetworkRoute } from "../device-network/settings";
import { readNetworkSettings } from "../device-network/settings";
import { parkedPairingHalves } from "../pairing";
import { prunePendingControllers } from "../pairing/controllers";
import { recordControllerAdded } from "../pairing/presence";
import { admitPhoneKey, evictionFor } from "../paired-phones";

export type RecoveryRequest = { id: string; phonePublicKey: string; expiresAt: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{43}$/;

/** The account server sees this envelope but has no key that can open it. */
export function createRecoveryOffer(request: RecoveryRequest, machineId: string): string {
  if (!UUID.test(request.id) || !UUID.test(machineId) || !KEY.test(request.phonePublicKey)
    || Buffer.from(request.phonePublicKey, "base64url").length !== 32
    || request.expiresAt <= Date.now() || request.expiresAt > Date.now() + 5 * 60_000) {
    throw new Error("Invalid or expired account recovery request.");
  }
  const existing = parkedPairingHalves();
  if (!existing && (existsSync(machineConfigPath()) || existsSync(phonePairingPath()))) {
    throw new Error("Existing pairing is incomplete; repair it before account recovery.");
  }
  const network = readNetworkSettings();
  const relayUrl = network.mode === "managed" ? DEFAULT_RELAY_URL : network.endpoint;
  let { machineCfg, phoneCfg } = existing ?? createPairing(relayUrl);
  if (existing) {
    machineCfg = prunePendingControllers(machineCfg);
    evictionFor(machineCfg);
    const keys = generateKeyPair();
    phoneCfg = { ...phoneCfg, peerPublicKey: machineCfg.myPublicKey,
      senderId: randomId(8), myPublicKey: keys.publicKey,
      mySecretKey: keys.secretKey };
  }
  const routedPhone = applyNetworkRoute(phoneCfg);
  const ephemeral = generateKeyPair();
  const payload = { schema: "granttap.account-offer.v1", requestId: request.id,
    machineId, pairing: routedPhone };
  const recipient = Buffer.from(request.phonePublicKey, "base64url").toString("base64");
  const box = seal(payload, recipient, ephemeral.secretKey);
  // Persist authorization before the server can deliver the phone half.
  if (!existing) {
    saveConfig(machineConfigPath(), machineCfg);
    saveConfig(phonePairingPath(), phoneCfg);
    recordControllerAdded(phoneCfg.myPublicKey);
  } else {
    admitPhoneKey(machineCfg.room, phoneCfg.myPublicKey, request.expiresAt);
  }
  return JSON.stringify({ senderPublicKey: ephemeral.publicKey, ...box });
}
