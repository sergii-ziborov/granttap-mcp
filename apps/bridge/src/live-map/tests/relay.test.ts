import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createPairing } from "../../config";
import { RelayClient } from "../../../../../packages/core/relay-client";
import { SessionPulses, type Payload } from "../../../../../packages/protocol/schema";
import { rememberPublishedCatalog } from "../../session-catalog";
import { forwardingRelay, waitFor } from "../../../../../tests/support/forwarding-relay";
import { handleLiveMapSubscription, stopLiveMap } from "..";

const MARK = "SECRET-MARK-relay-5d1e";
const SESSION = "live-map-relay-chat";

const row = (value: Record<string, unknown>) => `${JSON.stringify({ timestamp: new Date().toISOString(), ...value })}\n`;
const toolUse = (id: string, name: string, input: unknown) => row({ type: "assistant",
  message: { id: `m-${id}`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id, name, input }] } });
const toolResult = (id: string, isError: boolean) => row({ type: "user", uuid: `r-${id}`,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: `${MARK} failed` }] } });

function isolate(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "granttap-live-map-relay-"));
  const saved = [process.env.GRANTTAP_CONFIG_DIR, process.env.GRANTTAP_CLAUDE_PROJECTS_DIR];
  process.env.GRANTTAP_CONFIG_DIR = join(root, "config");
  process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = join(root, "claude");
  t.after(() => {
    for (const [name, value] of [["GRANTTAP_CONFIG_DIR", saved[0]], ["GRANTTAP_CLAUDE_PROJECTS_DIR", saved[1]]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  return root;
}

test("a phone that opens the live map gets the chat's pulses through the relay, sealed, names only", async (t) => {
  const root = isolate(t);
  const project = join(root, "claude", "-repo");
  mkdirSync(project, { recursive: true });
  const transcript = join(project, `${SESSION}.jsonl`);
  writeFileSync(transcript, row({ type: "user", uuid: "u1", message: { role: "user", content: `do ${MARK}` } })
    + toolUse("t1", "Read", { file_path: `/Users/me/${MARK}/a.ts` }) + toolResult("t1", false));

  const relay = await forwardingRelay();
  t.after(() => relay.close());
  const { machineCfg, phoneCfg } = createPairing(relay.url);
  phoneCfg.relayUrl = `${relay.url}/ws`;
  const machine = new RelayClient(machineCfg, { minReconnectMs: 50 });
  const phone = new RelayClient(phoneCfg, { minReconnectMs: 50 });
  const wire: string[] = [];
  const spy = new WebSocket(relay.url);
  spy.on("message", data => wire.push(String(data)));
  t.after(() => { stopLiveMap(machine); machine.close(); phone.close(); spy.close(); });

  rememberPublishedCatalog(machine, { type: "sessions.status", machine: "Mac", generatedAt: Date.now(),
    sessions: [{ sessionId: SESSION, agent: "claude", state: "working", startedAt: 1, lastActivityAt: Date.now(),
      tokensSession: 0, tokensLastTurn: 0 }] });
  machine.onMessage((payload, peer) => payload.type === "session.pulses.subscribe"
    && handleLiveMapSubscription(machine, payload, peer));
  const frames: SessionPulses[] = [];
  phone.onMessage((payload: Payload) => {
    if (payload.type !== "session.pulses") return false;
    frames.push(SessionPulses.parse(payload));
    return true;
  });

  await machine.connect();
  await phone.connect();
  await waitFor(() => relay.connections() === 3, 2_000);
  await phone.send({ type: "session.pulses.subscribe", sessionId: SESSION, active: true, createdAt: Date.now() }, "machine");

  await waitFor(() => frames.length >= 1, 3_000);
  const replay = frames[0]!;
  assert.equal(replay.replay, true);
  assert.equal(replay.agent, "claude");
  assert.deepEqual(replay.pulses.map(pulse => [pulse.station, pulse.mark ?? pulse.name, pulse.phase]),
    [["you", "message", "done"], ["model", "step", "done"], ["files", "Read", "done"]]);

  appendFileSync(transcript, toolUse("t2", "Bash", { command: `curl https://${MARK}.test`, description: MARK }));
  await waitFor(() => frames.some(frame => frame.pulses.some(pulse => pulse.phase === "start" && pulse.name === "Bash")), 3_000);
  const started = frames.flatMap(frame => frame.pulses).find(pulse => pulse.name === "Bash")!;
  assert.equal(started.station, "web");
  assert.ok(frames.at(-1)!.running.includes(started.id));

  appendFileSync(transcript, toolResult("t2", true));
  await waitFor(() => frames.some(frame => frame.pulses.some(pulse => pulse.id === started.id && pulse.phase === "end")), 3_000);
  const ended = frames.flatMap(frame => frame.pulses).find(pulse => pulse.id === started.id && pulse.phase === "end")!;
  assert.equal(ended.status, "error");
  assert.equal(frames.at(-1)!.running.includes(started.id), false);
  assert.deepEqual(frames.at(-1)!.counts, { you: 1, model: 2, files: 1, web: 1 });

  const seq = frames.map(frame => frame.seq);
  assert.deepEqual(seq, [...seq].sort((a, b) => a - b), "frames arrive in order");
  const gaps = frames.slice(1).map((frame, i) => frame.generatedAt - frames[i]!.generatedAt);
  assert.ok(gaps.every(gap => gap >= 900), `at most one frame a second: ${gaps.join(", ")}`);
  assert.equal(JSON.stringify(frames).includes(MARK), false, "no argument, path, command or result reaches the phone");
  assert.ok(wire.length > 0);
  for (const frame of wire) {
    assert.equal(frame.includes(MARK) || frame.includes("session.pulses") || frame.includes("Bash"), false,
      "the relay sees only ciphertext");
  }
  await phone.send({ type: "session.pulses.subscribe", sessionId: SESSION, active: false, createdAt: Date.now() }, "machine");
  const count = frames.length;
  await new Promise(resolve => setTimeout(resolve, 1_300));
  assert.equal(frames.length, count, "a closed map gets no more frames");
});
