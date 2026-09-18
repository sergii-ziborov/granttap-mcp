import { generateTransferKey, randomId, sealWithTransferKey } from "../../../packages/core/crypto";
import {
  installClaudeHook,
  installCodexHook,
  installCursorHook,
  installMonitorHelper,
  type InstallResult,
} from "./install";
import {
  createPairing,
  DEFAULT_RELAY_URL,
  loadConfig,
  machineConfigPath,
  normalizeRelayUrl,
  phonePairingPath,
  saveConfig,
} from "./config";
import type { PeerConfig } from "../../../packages/core/relay-client";
import type { PairingJoin } from "../../../packages/protocol/messages/pairing-join";
import { clearPhoneSeen } from "./presence";

export const DEFAULT_RELAY = DEFAULT_RELAY_URL;
export const PAIRING_CODE_TTL_MINUTES = 15;

function validConfig(config: PeerConfig, role: PeerConfig["role"]): boolean {
  return config.role === role
    && [config.relayUrl, config.room, config.senderId, config.myPublicKey,
      config.mySecretKey, config.peerPublicKey].every((value) => value.length > 0);
}

/** Return the shared machine identity only when both local halves are reciprocal. */
export function reusablePairing(replace = false): PeerConfig | null {
  if (replace) return null;
  try {
    const machine = loadConfig(machineConfigPath());
    const phone = loadConfig(phonePairingPath());
    return validConfig(machine, "machine")
      && validConfig(phone, "phone")
      && machine.room === phone.room
      && machine.relayUrl === phone.relayUrl
      && machine.myPublicKey === phone.peerPublicKey
      && machine.peerPublicKey === phone.myPublicKey
      ? machine
      : null;
  } catch {
    return null;
  }
}

export type OneTimePairing = {
  machineCfg: PeerConfig;
  phoneCfg: PeerConfig;
  mailboxId: string;
  transferKey: string;
  manualToken: string;
  httpBase: string;
  qrPayload: string;
  cursor: InstallResult | null;
  claude: InstallResult | null;
  codex: InstallResult | null;
  monitor: InstallResult | null;
};

export function relayHttpBase(relayUrl: string): string {
  const url = new URL(normalizeRelayUrl(relayUrl));
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.toString().replace(/\/$/, "");
}

/**
 * The QR contains a random mailbox id plus an independent 256-bit transfer key.
 * The mailbox id is the only part sent to the relay. The relay deletes the
 * ciphertext after the first successful GET and expires it after 15 minutes.
 */
export function oneTimePairingUri(relayUrl: string, mailboxId: string, transferKey: string): string {
  const query = new URLSearchParams({
    v: "2",
    u: relayHttpBase(relayUrl),
    m: mailboxId,
    k: transferKey,
  });
  return `granttap://pair-v2?${query.toString()}`;
}

/** Reciprocal machine + phone halves when both local files still match. */
export function reusablePairingHalves(): { machineCfg: PeerConfig; phoneCfg: PeerConfig } | null {
  const machineCfg = reusablePairing(false);
  if (!machineCfg) return null;
  try {
    const phoneCfg = loadConfig(phonePairingPath());
    return validConfig(phoneCfg, "phone") ? { machineCfg, phoneCfg } : null;
  } catch {
    return null;
  }
}

/** Same room on disk, even if the key halves drifted and are no longer reciprocal. */
export function parkedPairingHalves(): { machineCfg: PeerConfig; phoneCfg: PeerConfig } | null {
  const halves = reusablePairingHalves();
  if (halves) return halves;
  try {
    const machineCfg = loadConfig(machineConfigPath());
    const phoneCfg = loadConfig(phonePairingPath());
    return validConfig(machineCfg, "machine")
      && validConfig(phoneCfg, "phone")
      && machineCfg.room === phoneCfg.room
      && machineCfg.relayUrl === phoneCfg.relayUrl
      ? { machineCfg, phoneCfg }
      : null;
  } catch {
    return null;
  }
}

function machineIdentityPresent(): boolean {
  try {
    return validConfig(loadConfig(machineConfigPath()), "machine");
  } catch {
    return false;
  }
}

/**
 * A new computer mints a candidate room until a phone that is already in a
 * room scans its QR. That scan moves this computer into the phone's room —
 * it does not create a second room. Reconnect re-issues a QR for this room.
 * `replace` starts a different room. A Mesh invite is not this room.
 */

export type PairingJoinResult = "adopted" | "already" | "rejected";

/**
 * The phone already had a room. This computer keeps its machine keys and
 * switches into that room so the next heartbeat lands where the phone is.
 */
export function applyPairingJoin(payload: PairingJoin): PairingJoinResult {
  let machine: PeerConfig;
  try {
    machine = loadConfig(machineConfigPath());
  } catch {
    return "rejected";
  }
  if (!validConfig(machine, "machine")) return "rejected";
  if (payload.phoneCfg.room !== payload.room) return "rejected";
  if (payload.phoneCfg.myPublicKey !== payload.phonePublicKey) return "rejected";
  if (!validConfig(payload.phoneCfg, "phone")) return "rejected";
  let relayUrl: string;
  try {
    relayUrl = normalizeRelayUrl(payload.relayUrl);
  } catch {
    return "rejected";
  }
  if (machine.room === payload.room && machine.peerPublicKey === payload.phonePublicKey
      && machine.relayUrl === relayUrl) {
    return "already";
  }
  const nextMachine: PeerConfig = {
    ...machine,
    relayUrl,
    room: payload.room,
    peerPublicKey: payload.phonePublicKey,
    pushAuth: payload.phoneCfg.pushAuth ?? machine.pushAuth,
  };
  if (!validConfig(nextMachine, "machine")) return "rejected";
  saveConfig(machineConfigPath(), nextMachine);
  saveConfig(phonePairingPath(), payload.phoneCfg);
  clearPhoneSeen();
  return "adopted";
}
export async function createOneTimePairing(
  relayUrl: string,
  options: { installHooks?: boolean; replace?: boolean } = {},
): Promise<OneTimePairing> {
  const existing = options.replace ? null : parkedPairingHalves();
  if (!existing && !options.replace && machineIdentityPresent()) {
    throw new Error(
      "GrantTap already has a pairing room on this computer, but the local phone half is missing or does not match. Reconnect reuses that room. Confirm replace only to start a different room.",
    );
  }
  const { machineCfg, phoneCfg } = existing ?? createPairing(relayUrl);
  const mailboxId = randomId(16);
  const transferKey = generateTransferKey();
  const sealed = sealWithTransferKey(phoneCfg, transferKey);
  const httpBase = relayHttpBase(relayUrl);

  let response: Response;
  try {
    response = await fetch(`${httpBase}/pair/${mailboxId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sealed),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch (error) {
    throw new Error(
      `The GrantTap relay is unavailable at ${httpBase}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new Error(`The GrantTap relay rejected pairing with HTTP ${response.status}.`);
  }

  // Do not replace a working local pairing until the relay has accepted the
  // encrypted phone half. A failed onboarding attempt must be non-destructive.
  // Reconnect re-parks the same halves — writing them again would rotate backups
  // and look like a new room.
  if (!existing) {
    saveConfig(machineConfigPath(), machineCfg);
    saveConfig(phonePairingPath(), phoneCfg);
    clearPhoneSeen();
  }

  const installHooks = options.installHooks ?? process.env.GRANTTAP_SKIP_HOOKS !== "1";
  const cursor = installHooks ? installCursorHook() : null;
  const claude = installHooks ? installClaudeHook() : null;
  const codex = installHooks ? installCodexHook() : null;
  const monitor = installHooks ? installMonitorHelper() : null;

  return {
    machineCfg,
    phoneCfg,
    mailboxId,
    transferKey,
    manualToken: `${mailboxId}.${transferKey}`,
    httpBase,
    qrPayload: oneTimePairingUri(relayUrl, mailboxId, transferKey),
    cursor,
    claude,
    codex,
    monitor,
  };
}
