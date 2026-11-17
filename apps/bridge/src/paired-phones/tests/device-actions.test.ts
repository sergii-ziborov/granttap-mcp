import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DeviceManagementRequest, DeviceManagementResult } from "../../../../../packages/protocol/schema";
import { handleDeviceManagement } from "../../device-management";
import { controllerPeerGate } from "../../pairing/controllers";
import { phoneId } from "..";
import { isolatedConfig, live, pairedComputer, type Fixture } from "./support";

type Sent = { value: DeviceManagementResult; peer: string; onDisk: boolean };

function computer(t: TestContext, extras: number, seen: Array<number | null>) {
  const root = isolatedConfig(t);
  const keys = ["GRANTTAP_COMPUTER_ID", "GRANTTAP_CLAUDE_BIN", "GRANTTAP_CODEX_BIN", "GRANTTAP_GROK_BIN",
    "GRANTTAP_CURSOR_AGENT_BIN", "GRANTTAP_GROK_DIR"] as const;
  const previous = keys.map((key) => process.env[key]);
  Object.assign(process.env, { GRANTTAP_COMPUTER_ID: "phones-mac", GRANTTAP_CLAUDE_BIN: process.execPath,
    GRANTTAP_CODEX_BIN: process.execPath, GRANTTAP_GROK_BIN: process.execPath,
    GRANTTAP_CURSOR_AGENT_BIN: process.execPath, GRANTTAP_GROK_DIR: root });
  t.after(() => keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
  }));
  // The handler reads the real clock, so the times are set against it.
  const f: Fixture = pairedComputer(extras, seen, { now: Date.now() });
  const sent: Sent[] = [];
  const client = { room: f.machine.room, sendToPeer: async (value: DeviceManagementResult, peer: string) => {
    sent.push({ value, peer, onDisk: [live().peerPublicKey, ...live().extraPeerPublicKeys ?? []].includes(peer) });
  } } as never;
  let counter = 0;
  const ask = async (peer: string, request: Partial<DeviceManagementRequest>) => {
    const full = DeviceManagementRequest.parse({ type: "device.manage", requestId: `phones-${++counter}`,
      computerId: request.action === "status" ? undefined : "phones-mac", createdAt: Date.now(), ...request });
    assert.equal(await handleDeviceManagement(client, full, peer), true);
    const until = Date.now() + 15_000;
    for (;;) {
      const done = sent.find((item) => item.value.requestId === full.requestId && ["completed", "failed"].includes(item.value.phase));
      if (done) return done;
      assert(Date.now() < until, "the computer answers");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { f, sent, ask };
}

test("a phone sees every phone of the computer, itself marked, in the status it already asks for", async (t) => {
  const { f, ask } = computer(t, 2, [0, 100, null]);
  const answer = await ask(f.extras[0]!, { action: "status" });
  assert.equal(DeviceManagementResult.safeParse(answer.value).success, true);
  const phones = answer.value.snapshot?.phones ?? [];
  assert.deepEqual(phones.map((phone) => phone.id), [f.primary, ...f.extras].map(phoneId));
  assert.deepEqual(phones.map((phone) => phone.thisPhone), [false, true, false]);
  assert.deepEqual(phones.map((phone) => phone.primary), [true, false, false]);
  assert.equal(phones[2]?.lastSeenAt, undefined, "never seen stays absent");
  assert.equal(answer.peer, f.extras[0], "the list goes only to the phone that asked");
});

test("removing others refuses the phone in use, then removes the rest at once", async (t) => {
  const { f, ask } = computer(t, 3, [0, 1, 200, 300]);
  const self = await ask(f.primary, { action: "phones-remove", phoneIds: [phoneId(f.primary), phoneId(f.extras[1]!)] });
  assert.equal(self.value.phase, "failed");
  assert.match(self.value.message, /Unpair this phone/);
  assert.equal(live().extraPeerPublicKeys?.length, 3, "a refused request removes nothing");

  const gate = controllerPeerGate(f.machine);
  const removed = await ask(f.primary, { action: "phones-remove", phoneIds: [phoneId(f.extras[1]!), phoneId(f.extras[2]!)] });
  assert.equal(removed.value.phase, "completed");
  assert.deepEqual(removed.value.removedPhoneIds, [phoneId(f.extras[1]!), phoneId(f.extras[2]!)]);
  assert.match(removed.value.message, /Removed 2 phones\. 2 phones stay paired/);
  assert.deepEqual(removed.value.snapshot?.phones?.map((phone) => phone.id), [phoneId(f.primary), phoneId(f.extras[0]!)]);
  assert.equal(gate(f.extras[1]!), false);
  const again = await ask(f.primary, { action: "phones-remove", phoneIds: [phoneId(f.extras[1]!)] });
  assert.equal(again.value.message, "Those phones were already removed.");
});

test("removing phones away for N days spares the phone asking, however long it was away", async (t) => {
  const { f, ask } = computer(t, 3, [90, 2, 45, null]);
  const answer = await ask(f.primary, { action: "phones-remove-stale", notSeenForDays: 30 });
  assert.equal(answer.value.phase, "completed");
  assert.deepEqual(answer.value.removedPhoneIds, [phoneId(f.extras[1]!), phoneId(f.extras[2]!)]);
  assert.deepEqual(live().extraPeerPublicKeys, [f.extras[0]]);
  assert.equal(live().peerPublicKey, f.primary);
  const none = await ask(f.primary, { action: "phones-remove-stale", notSeenForDays: 30 });
  assert.equal(none.value.message, "No other phone has been away for 30 days.");
});

test("unpairing this phone answers it first, then removes its key; the only phone stays", async (t) => {
  const { f, ask } = computer(t, 1, [0, 0]);
  const answer = await ask(f.extras[0]!, { action: "phones-unpair-self" });
  assert.equal(answer.value.phase, "completed");
  assert.equal(answer.onDisk, true, "the phone is answered while it can still be reached");
  assert.deepEqual(answer.value.removedPhoneIds, [phoneId(f.extras[0]!)]);
  assert.deepEqual(live().extraPeerPublicKeys, []);
  const only = await ask(f.primary, { action: "phones-unpair-self" });
  assert.equal(only.value.phase, "failed");
  assert.match(only.value.message, /only phone/);
  assert.equal(live().peerPublicKey, f.primary);
});

test("phone requests name exactly what they act on", () => {
  const base = { type: "device.manage", requestId: "qa", computerId: "mac", createdAt: 1 };
  const id = "a".repeat(64);
  for (const value of [{ ...base, action: "phones-remove" }, { ...base, action: "phones-remove", phoneIds: [] },
    { ...base, action: "phones-remove", phoneIds: ["abc123"] }, { ...base, action: "phones-remove-stale" },
    { ...base, action: "phones-remove-stale", notSeenForDays: 0 }, { ...base, action: "status", phoneIds: [id] },
    { ...base, action: "phones-unpair-self", notSeenForDays: 30 }, { ...base, computerId: undefined, action: "phones-unpair-self" }]) {
    assert.equal(DeviceManagementRequest.safeParse(value).success, false, JSON.stringify(value));
  }
  for (const value of [{ ...base, action: "phones-remove", phoneIds: [id] },
    { ...base, action: "phones-remove-stale", notSeenForDays: 30 }, { ...base, action: "phones-unpair-self" }]) {
    assert.equal(DeviceManagementRequest.safeParse(value).success, true, JSON.stringify(value));
  }
});
