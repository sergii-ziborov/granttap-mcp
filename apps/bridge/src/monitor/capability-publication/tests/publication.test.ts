import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { publishMonitorCapabilities, stopMonitorCapabilities } from "..";
import type { SessionsStatus } from "../../../../../../packages/protocol/schema";

const status: SessionsStatus = { type: "sessions.status", machine: "Fixture",
  sessions: [], generatedAt: 1 };

test("usage publication retries a failure and does not duplicate a successful report", async () => {
  let attempts = 0;
  const client = { room: "isolated", isConnected: true,
    send: async () => { if (++attempts === 1) throw Error("fixture transport failure"); } };
  const history = async () => [];
  publishMonitorCapabilities(client as never, status, history);
  await setImmediate(); await setImmediate();
  assert.equal(attempts, 1);
  publishMonitorCapabilities(client as never, status, history);
  await setImmediate(); await setImmediate();
  assert.equal(attempts, 2);
  publishMonitorCapabilities(client as never, status, history);
  await setImmediate();
  assert.equal(attempts, 2, "Successful reports keep their existing cadence");
  stopMonitorCapabilities(client as never);
});

test("one usage read is shared while pending and closing discards its queued send", async () => {
  let reads = 0, sent = 0;
  let release!: (sessions: []) => void;
  const held = new Promise<[]>(resolve => { release = resolve; });
  const client = { room: "isolated", isConnected: true, send: async () => { sent++; } };
  const history = () => { reads++; return held; };
  publishMonitorCapabilities(client as never, status, history);
  publishMonitorCapabilities(client as never, status, history);
  await setImmediate();
  assert.equal(reads, 1);
  stopMonitorCapabilities(client as never);
  release([]);
  await setImmediate();
  assert.equal(sent, 0);
  client.isConnected = false;
  publishMonitorCapabilities(client as never, status, async () => []);
  await setImmediate();
  assert.equal(sent, 0);
  stopMonitorCapabilities(client as never);
});
