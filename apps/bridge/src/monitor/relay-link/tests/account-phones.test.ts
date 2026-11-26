import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { generateKeyPair } from "../../../../../../packages/core/crypto";
import { createPairing, machineConfigPath, saveConfig } from "../../../config";
import { saveAccountLink } from "../../../account-recovery/link";
import { recordAccountCheck, resetAccountCheckFailures } from "../../../account-link-state";
import { accountRefusalHint, adoptAdmittedPhones } from "../account-phones";

function privateConfig(t: TestContext): void {
  const directory = mkdtempSync(join(tmpdir(), "granttap-account-phones-"));
  process.env.GRANTTAP_CONFIG_DIR = directory;
  resetAccountCheckFailures();
  t.mock.method(process.stderr, "write", () => true);
  t.after(() => { delete process.env.GRANTTAP_CONFIG_DIR; rmSync(directory, { recursive: true, force: true }); });
}

test("a phone admitted through the account joins the running monitor's link without a restart", async t => {
  privateConfig(t);
  const { machineCfg } = createPairing("wss://relay.granttap.com");
  const added = generateKeyPair().publicKey;
  saveConfig(machineConfigPath(), { ...machineCfg, extraPeerPublicKeys: [added] });
  const peers: string[] = [];
  let published = 0, restarted = 0;
  adoptAdmittedPhones({ room: machineCfg.room, addControllerPeer: key => { peers.push(key); } },
    async () => { published++; }, () => { restarted++; });
  assert.deepEqual(peers, [machineCfg.peerPublicKey, added]);
  assert.equal(published, 1);
  assert.equal(restarted, 0);
  adoptAdmittedPhones({ room: "another-room", addControllerPeer: () => { throw new Error("unused"); } },
    async () => { published++; }, () => { restarted++; });
  assert.equal(restarted, 1, "a pairing for another room needs a fresh monitor");
});

test("the link-restart is skipped, with the reason, when the account and not the link is refused", t => {
  privateConfig(t);
  assert.match(accountRefusalHint() ?? "", /not signed in to a GrantTap account; run granttap sign-in/);
  saveAccountLink({ accountId: "11111111-1111-4111-8111-111111111111",
    machineId: "22222222-2222-4222-8222-222222222222", machineToken: "A".repeat(43) });
  assert.equal(accountRefusalHint(), null, "a working sign-in leaves the restart to the link watch");
  recordAccountCheck("admission", { kind: "not_covered", state: "no_subscription", reason: "No plan." });
  assert.equal(accountRefusalHint(), "this computer is not covered by the GrantTap subscription (No plan.)");
  recordAccountCheck("poll", { kind: "revoked", reason: "Machine access revoked." });
  assert.match(accountRefusalHint() ?? "", /signed out of its GrantTap account/);
});
