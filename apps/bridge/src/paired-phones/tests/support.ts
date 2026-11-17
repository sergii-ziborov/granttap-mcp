import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { generateKeyPair } from "../../../../../packages/core/crypto";
import type { PeerConfig } from "../../../../../packages/core/relay-client";
import { createPairing, loadConfig, machineConfigPath, phonePairingPath, saveConfig } from "../../config";
import { writePrivateFile } from "../../config/access/write-private";
import { configDir } from "../../config/runtime/paths";
import { recordControllerAdded, recordPhoneSeen } from "../../pairing/presence";

export const DAY = 86_400_000;
export const NOW = Date.UTC(2026, 10, 14, 12);

/** A private GrantTap config directory for one test; nothing outside it is read or written. */
export function isolatedConfig(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "granttap-paired-phones-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

export type Fixture = { machine: PeerConfig; primary: string; extras: string[] };

/**
 * A paired computer with `extras` added phones, each already scanned 400 days before `now`. `seen[i]` is how
 * many days before `now` phone i (0 = the first pairing) last reached the computer; null: never.
 */
export function pairedComputer(extras: number, seen: Array<number | null> = [],
  options: { relayUrl?: string; now?: number } = {}): Fixture {
  const now = options.now ?? NOW;
  const { machineCfg, phoneCfg } = createPairing(options.relayUrl ?? "ws://127.0.0.1:1");
  const keys = Array.from({ length: extras }, () => generateKeyPair().publicKey);
  const machine = { ...machineCfg, extraPeerPublicKeys: keys };
  saveConfig(machineConfigPath(), machine);
  saveConfig(phonePairingPath(), phoneCfg);
  // An enrollment journal exists once any phone was added; scanned phones have left it.
  writePrivateFile(join(configDir(), "pending-controllers.json"), "[]\n");
  for (const key of keys) recordControllerAdded(key, now - 400 * DAY);
  [machine.peerPublicKey, ...keys].forEach((key, index) => {
    const days = seen[index];
    if (days != null) recordPhoneSeen(now - days * DAY, key);
  });
  return { machine: loadConfig(machineConfigPath()), primary: machine.peerPublicKey, extras: keys };
}

export function live(): PeerConfig {
  return loadConfig(machineConfigPath());
}

/** The relay's one-time mailbox, accepting every upload. */
export async function mailboxRelay(t: TestContext): Promise<string> {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => { response.statusCode = 201; response.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("relay did not listen");
  return `ws://127.0.0.1:${address.port}`;
}
