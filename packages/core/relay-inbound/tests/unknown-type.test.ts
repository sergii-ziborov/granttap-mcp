import assert from "node:assert/strict";
import test from "node:test";
import { createPairing } from "../../../../apps/bridge/src/config";
import { sealEnvelope } from "../../relay-envelope";
import { openRelayMessage } from "../index";

test("a message of a type this computer does not know is dropped, and the next one still opens", () => {
  const paired = createPairing("ws://127.0.0.1:1");
  const open = (payload: unknown) => openRelayMessage(
    paired.machineCfg, JSON.parse(sealEnvelope(paired.phoneCfg, payload as never, "machine")), new Map(), () => true,
  );
  // What a newer phone might send to an older computer: authenticated, well sealed, and unknown.
  assert.equal(open({ type: "signin.later", id: "a1b2c3d4e5f6a7b8", createdAt: 1 }), undefined);
  assert.equal(open({ type: "signin.result", id: "a1b2c3d4e5f6a7b8", outcome: "approved", createdAt: 1 }), undefined,
    "a known type with a value this version does not know is dropped the same way");
  const known = open({ type: "signin.result", id: "a1b2c3d4e5f6a7b8", outcome: "cancelled", createdAt: 1 });
  assert.equal(known?.payload.type, "signin.result");
  assert.equal(known?.peerPublicKey, paired.phoneCfg.myPublicKey, "and it says which phone sent it");
});
