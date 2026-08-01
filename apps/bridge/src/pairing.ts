import { generatePairingCode, normalizeCode, sealWithCode } from "../../../packages/core/crypto";
import {
  installClaudeHook,
  installCodexHook,
  installMonitorHelper,
  type InstallResult,
} from "./install";
import {
  createPairing,
  machineConfigPath,
  phonePairingPath,
  saveConfig,
} from "./config";
import type { PeerConfig } from "../../../packages/core/relay-client";

export const DEFAULT_RELAY = "wss://granttap-relay.sergii-ziborov.workers.dev";
export const PAIRING_CODE_TTL_MINUTES = 15;

export type OneTimePairing = {
  machineCfg: PeerConfig;
  phoneCfg: PeerConfig;
  code: string;
  formattedCode: string;
  httpBase: string;
  qrPayload: string;
  claude: InstallResult | null;
  codex: InstallResult | null;
  monitor: InstallResult | null;
};

export function relayHttpBase(relayUrl: string): string {
  return relayUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/$/, "");
}

/**
 * A chat-safe QR contains only the short-lived retrieval code, never the
 * phone's persistent secret key. The relay deletes the parked ciphertext after
 * the first successful GET and expires it after 15 minutes.
 */
export function oneTimePairingUri(relayUrl: string, code: string): string {
  const query = new URLSearchParams({
    v: "1",
    u: relayHttpBase(relayUrl),
    c: normalizeCode(code),
  });
  return `granttap://pair-code?${query.toString()}`;
}

/** Create, park, and persist a new E2EE pairing for chat or CLI onboarding. */
export async function createOneTimePairing(
  relayUrl: string,
  options: { installHooks?: boolean } = {},
): Promise<OneTimePairing> {
  const { machineCfg, phoneCfg } = createPairing(relayUrl);
  const code = generatePairingCode(8);
  const sealed = sealWithCode(phoneCfg, code);
  const httpBase = relayHttpBase(relayUrl);

  let response: Response;
  try {
    response = await fetch(`${httpBase}/pair/${code}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sealed),
      signal: AbortSignal.timeout(10_000),
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
  const claude = installHooks ? installClaudeHook() : null;
  const codex = installHooks ? installCodexHook() : null;
  const monitor = installHooks ? installMonitorHelper() : null;

  return {
    machineCfg,
    phoneCfg,
    code,
    formattedCode: `${code.slice(0, 4)} ${code.slice(4)}`,
    httpBase,
    qrPayload: oneTimePairingUri(relayUrl, code),
    claude,
    codex,
    monitor,
  };
}
