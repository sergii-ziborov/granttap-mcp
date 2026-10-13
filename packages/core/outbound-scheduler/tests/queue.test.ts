import assert from "node:assert/strict";
import test from "node:test";
import { OutboundFrameQueue, sendEncryptedPayload } from "..";
import { generateKeyPair, open } from "../../crypto";

test("explicit decisions pass queued snapshots while preserving each completed write", async t => {
  const writes: string[] = [];
  let release!: () => void, start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const queue = new OutboundFrameQueue(async frame => {
    writes.push(frame);
    if (frame === "first") { start(); await blocked; }
  }, 0);
  t.after(() => queue.cancel());
  const first = queue.send("first");
  await started;
  const snapshot = queue.send("snapshot"), decision = queue.send("decision", true);
  release();
  await Promise.all([first, snapshot, decision]);
  assert.deepEqual(writes, ["first", "decision", "snapshot"]);
});

test("queue admission is bounded and a disconnected generation cannot send later", async () => {
  const queue = new OutboundFrameQueue(async () => {});
  const admitted = queue.send("x".repeat(8 * 1024 * 1024)).catch(error => error);
  await assert.rejects(queue.send("overflow"), /queue is full/);
  queue.cancel();
  assert.match((await admitted).message, /connection closed/);
  await assert.rejects(queue.send("next-generation"), /connection closed/);
});

test("a write failure is reported and does not freeze later controls", async t => {
  let count = 0;
  const queue = new OutboundFrameQueue(async () => {
    if (++count === 1) throw new Error("disconnected");
  }, 0);
  t.after(() => queue.cancel());
  const failed = queue.send("first"), later = queue.send("later");
  await assert.rejects(failed, /disconnected/);
  await later;
  assert.equal(count, 2);
});

test("disconnect releases a catalog write even when the socket callback never completes", async () => {
  let started!: () => void;
  const writing = new Promise<void>(resolve => { started = resolve; });
  const queue = new OutboundFrameQueue(async () => {
    started();
    await new Promise<void>(() => {});
  }, 0);
  const catalog = queue.send("catalog").then(() => "sent", () => "cancelled");
  await writing;
  queue.cancel();
  const result = await Promise.race([catalog,
    new Promise<string>(resolve => setTimeout(() => resolve("still waiting"), 100))]);
  assert.equal(result, "cancelled");
});

test("a fresh catalog passes queued bulk data", async t => {
  const machine = generateKeyPair(), phone = generateKeyPair();
  let release!: () => void, start!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { start = resolve; });
  const writes: string[] = [];
  const queue = new OutboundFrameQueue(async frame => {
    if (frame === "first") { writes.push(frame); start(); await held; return; }
    if (frame === "bulk") { writes.push(frame); return; }
    const envelope = JSON.parse(frame);
    const payload = open(envelope.nonce, envelope.box, phone.publicKey, machine.secretKey) as { type: string };
    writes.push(payload.type);
  }, 0);
  t.after(() => queue.cancel());
  const first = queue.send("first"); await started;
  const bulk = queue.send("bulk");
  const catalog = sendEncryptedPayload(queue, { relayUrl: "ws://127.0.0.1", room: "fixture",
    role: "machine", senderId: "machine", deviceName: "Fixture", myPublicKey: machine.publicKey,
    mySecretKey: machine.secretKey, peerPublicKey: phone.publicKey }, () => true, {
      payload: { type: "sessions.status", machine: "Fixture", sessions: [], generatedAt: Date.now() },
      to: "phone", options: { reliable: false },
    });
  release(); await Promise.all([first, bulk, catalog]);
  assert.deepEqual(writes, ["first", "sessions.status", "bulk"]);
});
