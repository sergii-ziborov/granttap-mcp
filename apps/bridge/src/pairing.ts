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
  machineConfigPath,
  normalizeRelayUrl,
  phonePairingPath,
  saveConfig,
} from "./config";
import type { PeerConfig } from "../../../packages/core/relay-client";

export const DEFAULT_RELAY = "wss://granttap-relay.sergii-ziborov.workers.dev";
export const PAIRING_CODE_TTL_MINUTES = 15;

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

/** Create, park, and persist a new E2EE pairing for chat or CLI onboarding. */
export async function createOneTimePairing(
  relayUrl: string,
  options: { installHooks?: boolean } = {},
): Promise<OneTimePairing> {
  const { machineCfg, phoneCfg } = createPairing(relayUrl);
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
  saveConfig(machineConfigPath(), machineCfg);
  saveConfig(phonePairingPath(), phoneCfg);

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
