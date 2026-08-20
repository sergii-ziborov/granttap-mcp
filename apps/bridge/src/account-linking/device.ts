import { createHash, randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import type { SecretVault } from "./contracts";

const DEVICE_SEED = "device-signing-seed-v1";

export function deviceIdentity(vault: SecretVault): {
  deviceId: string; publicKey: string; secretKey: Uint8Array;
} {
  const saved = vault.load(DEVICE_SEED);
  const seed = saved == null ? randomBytes(32) : Buffer.from(saved, "base64url");
  if (seed.length !== 32 || (saved != null && seed.toString("base64url") !== saved)) {
    throw new Error("GrantTap device identity in protected storage is invalid");
  }
  if (saved == null) vault.save(DEVICE_SEED, seed.toString("base64url"));
  const pair = nacl.sign.keyPair.fromSeed(seed);
  const publicKey = Buffer.from(pair.publicKey).toString("base64url");
  const digest = createHash("sha256").update("granttap/device-id/v1\0")
    .update(pair.publicKey).digest("base64url");
  return { deviceId: `gtdev_${digest}`, publicKey, secretKey: pair.secretKey };
}

export function challenge(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function subjectKeyId(publicKey: string): Buffer {
  const key = Buffer.from(publicKey, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== publicKey) {
    throw new Error("canonical GrantTap device public key required");
  }
  return createHash("sha256").update("granttap/device-subject-key-id/v1\0").update(key).digest();
}

export function proof(fields: Record<string, string | number>, secretKey: Uint8Array): string {
  const canonical = Object.keys(fields).sort().map((key) => `${key}=${String(fields[key])}`).join("\n");
  return Buffer.from(nacl.sign.detached(
    Buffer.from(`granttap/control/device-login/v1\n${canonical}`), secretKey,
  )).toString("base64url");
}
