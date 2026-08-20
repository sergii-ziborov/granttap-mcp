import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { completeLogin, startLogin } from "../apps/bridge/src/account-linking/client";
import type { SecretVault } from "../apps/bridge/src/account-linking/contracts";
import { AccountStore } from "../apps/bridge/src/account-linking/store";

class MemoryVault implements SecretVault {
  readonly values = new Map<string, string>();
  load(account: string): string | null { return this.values.get(account) ?? null; }
  save(account: string, value: string): void { this.values.set(account, value); }
  remove(account: string): void { this.values.delete(account); }
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("device login QR excludes machine secrets and logout preserves phone pairing", async () => {
  const root = mkdtempSync(join(tmpdir(), "granttap-public-account-"));
  const vault = new MemoryVault();
  const store = new AccountStore(root, vault);
  let publicKey = "";
  const authorization = await startLogin(store, {
    controlUrl: "https://control.granttap.test", mode: "personal", now: 100_000,
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(String(init?.body)); publicKey = request.devicePublicKey;
      assert.match(request.proof, /^[A-Za-z0-9_-]{86}$/);
      return response({
        deviceCode: "machine-only-secret-code-123456789", userCode: "ABCD-1234",
        verificationUri: "https://control.granttap.test/device",
        verificationUriComplete: "https://control.granttap.test/device?user_code=ABCD-1234",
        expiresInSec: 600, intervalSec: 5,
      });
    },
  });
  assert.equal(authorization.verificationUriComplete.includes("machine-only"), false);
  assert.equal(await completeLogin(store, async () => response({ status: "pending" }, 202), 101_000), "pending");
  assert.equal(await completeLogin(store, async () => response({
    status: "authorized", accessToken: "a".repeat(64), refreshToken: "r".repeat(64),
    account: { mode: "personal", accountId: "account_123456789", userId: "user-1",
      deviceId: "device-1", devicePublicKey: publicKey, expiresAt: 999_999 },
  }), 102_000), "authorized");
  assert.equal(readFileSync(join(root, "account.json"), "utf8").includes("a".repeat(64)), false);
  writeFileSync(join(root, "machine.json"), "pairing-stays");
  store.logout();
  assert.equal(readFileSync(join(root, "machine.json"), "utf8"), "pairing-stays");
  assert.equal(store.status().kind, "signed_out");
});

test("device authorization QR contains only its exact one-time user code", async () => {
  const root = mkdtempSync(join(tmpdir(), "granttap-public-account-leak-"));
  await assert.rejects(startLogin(new AccountStore(root, new MemoryVault()), {
    controlUrl: "https://control.granttap.test", mode: "personal",
    fetchImpl: async () => response({
      deviceCode: "machine-only-secret-code-123456789", userCode: "ABCD-1234",
      verificationUri: "https://control.granttap.test/device",
      verificationUriComplete: "https://control.granttap.test/device?device_code=machine-only-secret-code-123456789",
      expiresInSec: 600, intervalSec: 5,
    }),
  }), /only its matching one-time user code/);

  await assert.rejects(startLogin(new AccountStore(root, new MemoryVault()), {
    controlUrl: "https://control.granttap.test", mode: "personal",
    fetchImpl: async () => response({
      deviceCode: "machine-only-secret-code-123456789", userCode: "ABCD-1234",
      verificationUri: "https://control.granttap.test/device",
      verificationUriComplete: "https://control.granttap.test/device?user_code=ABCD-1234&token=unexpected",
      expiresInSec: 600, intervalSec: 5,
    }),
  }), /only its matching one-time user code/);
});
