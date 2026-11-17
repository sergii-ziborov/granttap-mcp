import assert from "node:assert/strict";
import test from "node:test";
import { createPairing } from "../../../../apps/bridge/src/config";
import { generateTransferKey } from "../../crypto";
import { sealEnvelope, sealSessionPayload } from "../../relay-envelope";
import { openRelayMessage, type UnreadableFrame } from "../index";

test("a phone's frame no consumer can read says why, and nothing of what it held", () => {
  const paired = createPairing("ws://127.0.0.1:1");
  const chatKey = generateTransferKey();
  const reports: UnreadableFrame[] = [];
  const open = (payload: unknown, keys = new Map([["chat-1", chatKey]]), from = paired.phoneCfg) => openRelayMessage(
    paired.machineCfg, JSON.parse(sealEnvelope(from, payload as never, "machine")), keys, () => true,
    (frame) => reports.push(frame));
  const query = (sessionId: string) => ({ type: "session.changes.query", sessionId, requestId: "r-1", createdAt: 1.5 });

  assert.equal(open(sealSessionPayload(query("chat-1") as never, "chat-1", chatKey))?.payload.type, "session.changes.query");
  assert.deepEqual(reports, [], "a readable request is no report");

  open(sealSessionPayload(query("chat-1") as never, "chat-1", chatKey), new Map());
  open(sealSessionPayload(query("chat-1") as never, "chat-1", generateTransferKey()));
  open(sealSessionPayload(query("chat-2") as never, "chat-1", chatKey));
  open(sealSessionPayload({ type: "session.changes.later", sessionId: "chat-1", secret: "x" } as never, "chat-1", chatKey));
  open({ type: "signin.later", id: "a1b2c3d4e5f6a7b8", createdAt: 1 });
  open({ type: "Not a Type!", note: "kept out of any log" });
  assert.deepEqual(reports, [
    { reason: "no-key" },
    { reason: "unopenable" },
    { reason: "wrong-scope", type: "session.changes.query" },
    { reason: "unknown", type: "session.changes.later" },
    { reason: "unknown", type: "signin.later" },
    { reason: "unknown", type: undefined },
  ]);

  reports.length = 0;
  const stranger = createPairing("ws://127.0.0.1:1").phoneCfg;
  assert.equal(open(query("chat-1"), undefined, { ...stranger, room: paired.machineCfg.room }), undefined);
  assert.deepEqual(reports, [], "a frame no allowed phone sealed is not this computer's to report");
});
