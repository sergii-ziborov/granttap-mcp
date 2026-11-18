import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PULSE_FRAME_BYTES, MAX_PULSES_PER_FRAME, SessionPulses, type LiveMapStation,
} from "../../../../../packages/protocol/schema";
import { PulseTracker } from "..";
import { MAX_PENDING, REPLAY_PULSES } from "../tracker";
import type { ObservedCall, Observation } from "../readers/shared";

const call = (key: string, station: LiveMapStation, startedAt: number, extra: Partial<ObservedCall> = {}): ObservedCall =>
  ({ key, station, name: "Bash", startedAt, status: "run", ...extra });
const seen = (calls: ObservedCall[], extra: Partial<Observation> = {}): Observation => ({ calls, agents: [], ...extra });

test("the first frame replays the chat's recent work and counts its whole window", () => {
  const calls = Array.from({ length: 40 }, (_, i) => call(`k${i}`, i % 2 ? "files" : "shell", i * 10,
    { status: i === 3 ? "run" : "ok", endedAt: i * 10 + 5 }));
  const tracker = new PulseTracker("s1", "claude");
  assert.equal(tracker.hasNews, true);
  tracker.observe(seen(calls, { model: "claude-opus-5-5", context: { usedTokens: 175_000, windowTokens: 200_000 } }));
  const frame = SessionPulses.parse(tracker.frame(1_000));
  assert.equal(frame.replay, true);
  assert.equal(frame.seq, 0);
  assert.equal(frame.pulses.length, REPLAY_PULSES + 1, "recent pulses and the older call still running");
  assert.equal(frame.pulses[0]?.phase, "start");
  assert.equal(frame.pulses.at(-1)?.phase, "done");
  assert.equal(frame.pulses.at(-1)?.durationMs, 5);
  assert.deepEqual(frame.counts, { shell: 20, files: 20 });
  assert.equal(frame.running.length, 1);
  assert.equal(frame.contextPercent, 88);
  assert.equal(frame.contextTokens, 175_000);
  assert.equal(frame.model, "claude-opus-5-5");
  assert.equal(tracker.hasNews, false);
});

test("later frames say what started and what ended since, once each", () => {
  const tracker = new PulseTracker("s1", "codex");
  tracker.observe(seen([call("a", "shell", 1)]));
  tracker.frame(10);
  tracker.observe(seen([call("a", "shell", 1), call("b", "shell", 2), call("c", "web", 3, { status: "ok", endedAt: 9 })]));
  let frame = SessionPulses.parse(tracker.frame(20));
  assert.equal(frame.replay, undefined);
  assert.deepEqual(frame.pulses.map(pulse => [pulse.phase, pulse.status, pulse.parallel]),
    [["start", "run", 2], ["done", "ok", undefined]]);
  assert.equal(frame.pulses[1]?.durationMs, 6);
  assert.equal(frame.running.length, 2);
  assert.deepEqual(frame.counts, { shell: 2, web: 1 });
  tracker.observe(seen([call("a", "shell", 1, { status: "error", endedAt: 30 }), call("b", "shell", 2),
    call("c", "web", 3, { status: "ok", endedAt: 9 })]));
  frame = SessionPulses.parse(tracker.frame(40));
  assert.deepEqual(frame.pulses.map(pulse => [pulse.phase, pulse.status, pulse.at, pulse.durationMs]),
    [["end", "error", 30, 29]]);
  tracker.observe(seen([call("b", "shell", 2)]));
  assert.equal(tracker.hasNews, false, "nothing new is not news");
  assert.equal(tracker.frame(50).pulses.length, 0);
});

test("ids are digests: a provider's call id, subagent id and chat stay on the computer", () => {
  const tracker = new PulseTracker("chat-secret-id", "claude");
  tracker.observe(seen([call("toolu_SECRET", "agents", 1, { agentKey: "agent-SECRET", mark: undefined }),
    call("message:SECRET", "you", 2, { status: "ok", endedAt: 2, mark: "message", name: "message" }),
    call("model:x", "model", 3, { status: "ok", endedAt: 3, mark: "model", name: "gpt-6", model: "gpt-6" })],
  { agents: ["agent-SECRET"] }));
  const frame = SessionPulses.parse(tracker.frame(5));
  const text = JSON.stringify({ ...frame, sessionId: "" });
  assert.equal(text.includes("SECRET"), false);
  assert.match(frame.pulses[0]!.id, /^[a-f0-9]{12}$/);
  assert.match(frame.pulses[0]!.agentId!, /^[a-f0-9]{8}$/);
  assert.equal(frame.agents?.[0], frame.pulses[0]!.agentId);
  assert.equal(frame.pulses[1]?.durationMs, undefined, "a moment has no duration");
  assert.equal(frame.pulses[2]?.model, "gpt-6");
});

test("a frame never holds more than its pulse and byte budget", () => {
  const tracker = new PulseTracker("s1", "claude");
  tracker.observe(seen([]));
  tracker.frame(0);
  const flood = Array.from({ length: 600 }, (_, i) => call(`f${i}`, "files", i, {
    status: "ok", endedAt: i + 1, name: `mcp-server-name: some long tool name ${i}`.slice(0, 64),
  }));
  tracker.observe(seen(flood));
  const frame = SessionPulses.parse(tracker.frame(1_000));
  assert.ok(frame.pulses.length <= MAX_PULSES_PER_FRAME);
  assert.ok(Buffer.byteLength(JSON.stringify(frame)) <= MAX_PULSE_FRAME_BYTES);
  assert.equal(frame.pulses.length + (frame.dropped ?? 0), 600, "every pulse is either sent or counted");
  assert.equal(frame.pulses.at(-1)?.at, 599, "the newest are the ones kept");
  assert.ok(600 - MAX_PENDING <= (frame.dropped ?? 0));
  assert.equal(frame.counts.files, 600);
  assert.equal(tracker.frame(2_000).dropped, undefined, "a dropped count is said once");
});

test("a chat without a reported window sends its tokens and no percentage", () => {
  const tracker = new PulseTracker("s1", "claude");
  tracker.observe(seen([], { context: { usedTokens: 2_000_000_000 } }));
  const frame = SessionPulses.parse(tracker.frame(1));
  assert.equal(frame.contextPercent, undefined);
  assert.equal(frame.contextTokens, 100_000_000);
  assert.equal(frame.agents, undefined);
});
