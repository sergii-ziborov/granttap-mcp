import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateKeyPair } from "../../../../../../packages/core/crypto";
import { RelayClient } from "../../../../../../packages/core/relay-client";
import { createPairing, loadConfig, machineConfigPath, saveConfig } from "../../../../../bridge/src/config";
import { phoneId } from "../../../../../bridge/src/paired-phones";
import { recordPhoneSeen } from "../../../../../bridge/src/pairing/presence";
import { forwardingRelay } from "../../../../../../tests/support/forwarding-relay";
import { connectInMemory, textResult } from "../../../../../../tests/support/mcp-client";
import { createGrantTapServer, resetRelay } from "../../../http/create-server";

delete process.env.CLAUDE_CODE_SESSION_ID;

test("remove_phones asks over the relay and keeps exactly the phone that answered yes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-remove-phones-relay-"));
  const relay = await forwardingRelay();
  process.env.GRANTTAP_CONFIG_DIR = root;
  resetRelay();
  t.after(async () => {
    resetRelay();
    delete process.env.GRANTTAP_CONFIG_DIR;
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });
  const paired = createPairing(relay.url);
  const answering = generateKeyPair(), forgotten = generateKeyPair().publicKey, recent = generateKeyPair().publicKey;
  saveConfig(machineConfigPath(), { ...paired.machineCfg, extraPeerPublicKeys: [answering.publicKey, forgotten, recent] });
  writeFileSync(join(root, "pending-controllers.json"), "[]\n");
  recordPhoneSeen(Date.now() - 40 * 86_400_000, answering.publicKey);
  recordPhoneSeen(Date.now() - 86_400_000, recent);

  const questions: string[] = [];
  const phone = new RelayClient({ ...paired.phoneCfg, senderId: "answering-phone",
    myPublicKey: answering.publicKey, mySecretKey: answering.secretKey });
  phone.onMessage(async (payload) => {
    if (payload.type !== "approval.request") return false;
    questions.push(payload.title);
    await phone.send({ type: "approval.decision", requestId: payload.requestId, decision: "allow",
      sessionId: payload.sessionId, decidedAt: Date.now(), decidedBy: "phone" }, "machine");
    return true;
  });
  await phone.connect();
  t.after(() => phone.close());
  const client = await connectInMemory(createGrantTapServer());
  t.after(() => client.close());

  const answer = await client.callTool({ name: "remove_phones", arguments: { notSeenForDays: 30 } });
  assert.equal(answer.isError, undefined, textResult(answer));
  const result = answer.structuredContent as { status: string; removed: Array<{ id: string }>;
    kept: Array<{ id: string; reason: string }>; remaining: number };
  assert.equal(questions.length, 1);
  assert.match(questions[0]!, /^Remove 3 phones from /, "the three idle phones were named, the answering one too");
  assert.equal(result.status, "removed");
  assert.deepEqual(result.removed.map((item) => item.id).sort(), [paired.phoneCfg.myPublicKey, forgotten].map(phoneId).sort());
  assert.deepEqual(result.kept, [{ ...result.kept[0]!, id: phoneId(answering.publicKey), reason: "the person answered on this phone" }]);
  assert.equal(result.remaining, 2);
  const after = loadConfig(machineConfigPath());
  assert.equal(after.peerPublicKey, answering.publicKey, "the phone that just answered takes the first pairing's place");
  assert.deepEqual(after.extraPeerPublicKeys, [recent]);
});
