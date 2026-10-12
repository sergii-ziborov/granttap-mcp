import assert from "node:assert/strict";
import test from "node:test";
import { OutboundFrameQueue } from "..";

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
