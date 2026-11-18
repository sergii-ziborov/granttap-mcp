import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OutboundFrameQueue, priorityControlPayload } from "../../../../../packages/core/outbound-scheduler";
import type { Payload, SessionInfo } from "../../../../../packages/protocol/schema";
import type { SendOptions } from "../../../../../packages/core/relay-client";
import { LiveMapStream } from "..";
import { FRAME_TTL_MS, KEEPALIVE_MS, MAX_SUBSCRIPTIONS, SUBSCRIPTION_TTL_MS, TICK_MS } from "../stream";
import type { Observation } from "../readers/shared";

class FakeClient {
  sent: Array<{ payload: Payload; options: SendOptions; sealed: boolean }> = [];
  keys = new Set<string>();
  fail = false;
  async send(payload: Payload, _to?: unknown, options: SendOptions = {}) { this.sent.push({ payload, options, sealed: false }); }
  async sendSession(payload: Payload, _id: string, _to?: unknown, options: SendOptions = {}) {
    if (this.fail) throw new Error("relay outbound snapshot superseded by newer traffic");
    this.sent.push({ payload, options, sealed: true });
  }
  setSessionKey(id: string) { this.keys.add(id); }
  hasSessionKey(id: string) { return this.keys.has(id); }
  frames() { return this.sent.filter(item => item.payload.type === "session.pulses"); }
  grants() { return this.sent.filter(item => item.payload.type === "session.key.grant"); }
}

function setup(t: { after: (fn: () => void) => void }) {
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = mkdtempSync(join(tmpdir(), "granttap-live-map-stream-"));
  t.after(() => { if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = previous; });
  const client = new FakeClient();
  const clock = { now: 1_000_000 };
  const state = { active: true, observation: { calls: [], agents: [] } as Observation, reads: 0 };
  const sessions = new Map<string, SessionInfo>(["a", "b", "c", "d", "e"].map(id => [id,
    { sessionId: id, agent: "claude", state: "working", startedAt: 1, lastActivityAt: 1, tokensSession: 0, tokensLastTurn: 0 }]));
  const stream = new LiveMapStream(client, {
    session: id => sessions.get(id),
    observe: () => { state.reads += 1; return state.observation; },
    active: () => state.active,
    now: () => clock.now,
  });
  t.after(() => stream.stop());
  const subscribe = (sessionId: string, active = true, peer = "phone-key") =>
    stream.subscribe({ type: "session.pulses.subscribe", sessionId, active, createdAt: clock.now }, peer);
  return { client, clock, state, stream, subscribe };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test("a subscription is answered at once, under the chat's key, to the phone that asked", async (t) => {
  const { client, stream, subscribe } = setup(t);
  assert.equal(subscribe("a"), true);
  await settle();
  await stream.tick();
  assert.equal(client.frames().length, 1);
  assert.equal(client.grants().length, 1, "the chat's key is granted once");
  const [frame] = client.frames();
  assert.equal(frame!.sealed, true);
  assert.deepEqual(frame!.options, { reliable: false, ttlMs: FRAME_TTL_MS, peerPublicKey: "phone-key" });
  assert.equal(frame!.payload.type === "session.pulses" && frame!.payload.replay, true);
});

test("frames are batched once a second, with a keepalive when nothing happens", async (t) => {
  const { client, clock, state, stream, subscribe } = setup(t);
  subscribe("a");
  await settle();
  state.observation = { calls: [{ key: "x", station: "shell", name: "Bash", startedAt: clock.now, status: "run" }], agents: [] };
  clock.now += TICK_MS;
  await stream.tick();
  assert.equal(client.frames().length, 2);
  assert.equal(client.grants().length, 1, "later frames reuse the key the phone already has");
  clock.now += TICK_MS;
  await stream.tick();
  assert.equal(client.frames().length, 2, "no news, no frame");
  clock.now += KEEPALIVE_MS;
  await stream.tick();
  assert.equal(client.frames().length, 3, "a keepalive says the map is still live");
  assert.equal(subscribe("a"), true);
  await settle();
  assert.equal(client.frames().length, 3, "a renewal is not a frame");
});

test("a map the phone stops renewing ends, and so does the computer's reading", async (t) => {
  const { client, clock, state, stream, subscribe } = setup(t);
  subscribe("a");
  await settle();
  clock.now += SUBSCRIPTION_TTL_MS;
  const reads = state.reads;
  await stream.tick();
  assert.equal(stream.open, 0);
  assert.equal(state.reads, reads, "an expired map reads nothing");
  subscribe("b");
  subscribe("b", false);
  await settle();
  assert.equal(stream.open, 0);
  assert.equal(client.frames().length, 2, "a map closed at once still had its first frame");
});

test("at most four maps are fed at once; the oldest makes room", async (t) => {
  const { stream, subscribe } = setup(t);
  for (const id of ["a", "b", "c", "d", "e"]) subscribe(id);
  await settle();
  assert.equal(stream.open, MAX_SUBSCRIPTIONS);
  subscribe("a", true, "another-phone");
  assert.equal(stream.open, MAX_SUBSCRIPTIONS);
});

test("nothing is read or sent while the relay is down or another monitor routes", async (t) => {
  const { client, state, stream, subscribe } = setup(t);
  state.active = false;
  subscribe("a");
  subscribe("unknown");
  await settle();
  await stream.tick();
  assert.equal(state.reads, 0);
  assert.equal(client.frames().length, 0);
});

test("a superseded frame is not fatal, and the key is granted again", async (t) => {
  const { client, clock, state, stream, subscribe } = setup(t);
  client.fail = true;
  subscribe("a");
  await settle();
  client.fail = false;
  state.observation = { calls: [{ key: "y", station: "files", name: "Read", startedAt: clock.now, status: "ok", endedAt: clock.now }], agents: [] };
  clock.now += TICK_MS;
  await stream.tick();
  assert.equal(client.grants().length, 2);
  assert.equal(client.frames().length, 1);
});

test("pulse frames ride the replaceable lane behind every answer", async () => {
  assert.equal(priorityControlPayload("session.pulses"), false);
  assert.equal(priorityControlPayload("session.pulses.subscribe"), false);
  const written: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queue = new OutboundFrameQueue(async frame => { written.push(frame); if (frame === "busy") await gate; }, 0);
  const all = [queue.send("busy", true), queue.send("pulses-1"), queue.send("pulses-2"), queue.send("answer", true)];
  await settle();
  release();
  await Promise.all(all);
  assert.deepEqual(written, ["busy", "answer", "pulses-1", "pulses-2"]);
});
