import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleMonitorMessage } from "../inbound";
import { generateKeyPair } from "../../../../../../packages/core/crypto";
import { readControllerLastSeenAt, readPhoneLastSeenAt } from "../../../pairing/presence";

test("authenticated controller traffic renews that controller's durable presence", async t => {
  process.env.GRANTTAP_CONFIG_DIR = mkdtempSync(join(tmpdir(), "granttap-controller-presence-"));
  t.after(() => { delete process.env.GRANTTAP_CONFIG_DIR; });
  const peer = generateKeyPair().publicKey;
  const before = Date.now();
  await handleMonitorMessage({} as never,
    { type: "hello", role: "phone", deviceName: "fixture", createdAt: before },
    { leadership: { acquire: () => false }, subscriptions: new Set(),
      publish: async () => {}, peerPublicKey: peer });
  assert.ok((readControllerLastSeenAt(peer) ?? 0) >= before);
  assert.ok((readPhoneLastSeenAt() ?? 0) >= before);
  assert.equal(readControllerLastSeenAt(generateKeyPair().publicKey), null);
});
