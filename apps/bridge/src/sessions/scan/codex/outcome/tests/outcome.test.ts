import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { deflateSync } from "node:zlib";
import { SessionInfo } from "../../../../../../../../packages/protocol/schema";
import { codexActivity, scanCodex } from "../..";
import { appendCodexActivity } from "../../activity/rows";
import { parseCodexFile } from "../../parse";
import { readTranscriptHistory } from "../../../../../transcript-history";
import { codexRetryAt, providerSentence, stopReason, stoppedFields, withCurrentLimit } from "..";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Codex's own retry wording for a local time: the clock alone on the same day, else the date too. */
function codexClock(reset: Date, at: Date): string {
  const hour = reset.getHours() % 12 || 12, minute = String(reset.getMinutes()).padStart(2, "0");
  const clock = `${hour}:${minute} ${reset.getHours() < 12 ? "AM" : "PM"}`;
  if (reset.toDateString() === at.toDateString()) return clock;
  const day = reset.getDate(), suffix = [11, 12, 13].includes(day % 100) ? "th"
    : ["th", "st", "nd", "rd"][day % 10] ?? "th";
  return `${MONTHS[reset.getMonth()]} ${day}${suffix}, ${reset.getFullYear()} ${clock}`;
}

function limitMessage(reset: Date, at: Date): string {
  return "You’ve hit your usage limit. Upgrade to Pro (https://example.com/pricing), visit https://example.com/usage"
    + ` to purchase more credits or try again at ${codexClock(reset, at)}.`;
}

function tinyPng(): Buffer {
  const crc = (bytes: Buffer) => {
    let value = ~0;
    for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1)); }
    return ~value >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc(14, 7))), chunk("IEND", Buffer.alloc(0))]);
}

type Row = { type: string; payload: Record<string, unknown> };

function sessionsRoot(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "granttap-codex-outcome-"));
  const day = join(root, "sessions", "2026", "11", "17");
  const work = join(root, "work");
  mkdirSync(day, { recursive: true });
  mkdirSync(join(work, "out"), { recursive: true });
  const previous = process.env.GRANTTAP_CODEX_SESSIONS_DIR;
  process.env.GRANTTAP_CODEX_SESSIONS_DIR = join(root, "sessions");
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_CODEX_SESSIONS_DIR;
    else process.env.GRANTTAP_CODEX_SESSIONS_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const write = (id: string, rows: Row[], start = Date.now() - 60_000) => {
    const path = join(day, `rollout-2026-11-17T00-00-00-${id}.jsonl`);
    const lines = [{ timestamp: new Date(start).toISOString(), type: "session_meta",
      payload: { id, cwd: work, originator: "codex_exec", source: "exec" } },
    ...rows.map((row, index) => ({ timestamp: new Date(start + (index + 1) * 100).toISOString(), ...row }))];
    writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    const end = (start + (rows.length + 1) * 100) / 1000;
    utimesSync(path, end, end);
    return path;
  };
  return { work, write };
}

/** What the chat said back, in order; the request rows are checked on their own. */
const answers = (entries: Array<{ kind: string; text: string; outcome?: string }>) =>
  entries.filter((entry) => entry.kind !== "user").map((entry) => [entry.kind, entry.text, entry.outcome]);
const event = (payload: Record<string, unknown>): Row => ({ type: "event_msg", payload });
const response = (payload: Record<string, unknown>): Row => ({ type: "response_item", payload });
const request = (text: string): Row[] => [
  response({ type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>fixture</environment_context>" }] }),
  response({ type: "message", role: "user", content: [{ type: "input_text", text }] }),
  event({ type: "item_completed", turn_id: "turn-1", item: { type: "UserMessage", id: "u1", content: [{ type: "text", text }] } }),
];
const agentItem = (id: string, text: string, phase: string): Row =>
  event({ type: "item_completed", turn_id: "turn-1", item: { type: "AgentMessage", id, phase, content: [{ type: "Text", text }] } });
const assistant = (id: string, text: string, phase: string): Row =>
  response({ type: "message", role: "assistant", id, phase, content: [{ type: "output_text", text }] });

test("a run its usage limit stopped says so on its card, in its transcript and as a usage limit", (t) => {
  const { write } = sessionsRoot(t);
  const at = new Date(Date.now() - 60_000), reset = new Date(at.getTime() + 2 * 3_600_000);
  reset.setSeconds(0, 0);
  const path = write("limit-run-0001", [event({ type: "task_started", turn_id: "turn-1" }),
    ...request("Draw a lighthouse at dusk as a wide picture, save the file, print the path, stop."),
    event({ type: "token_count", info: null }),
    event({ type: "task_complete", turn_id: "turn-1", last_agent_message: null,
      error: { message: limitMessage(reset, at), codex_error_info: "usage_limit_exceeded" } })], at.getTime());
  const session = parseCodexFile(path)!.session;
  assert.equal(session.state, "idle");
  assert.equal(session.summary, "Codex stopped: You’ve hit your usage limit.");
  assert.equal(session.stopped?.reason, "usage_limit");
  assert.equal(session.stopped?.message, "You’ve hit your usage limit.");
  assert.deepEqual(session.usageLimit, { resetsAt: reset.getTime() });
  assert.equal(SessionInfo.parse(session).stopped?.reason, "usage_limit");
  const published = scanCodex().sessions.find((item) => item.sessionId === "limit-run-0001")!;
  for (const entries of [codexActivity(published), readTranscriptHistory(published)!.entries]) {
    assert.ok(entries.some((entry) => entry.kind === "user"
      && entry.text === "Draw a lighthouse at dusk as a wide picture, save the file, print the path, stop."));
    assert.deepEqual(answers(entries), [["final", "Codex stopped: You’ve hit your usage limit.", "error"]]);
  }
});

test("an image run's answer in items and in older messages is shown once, and names its picture", (t) => {
  const { work, write } = sessionsRoot(t);
  const picture = join(work, "out", "lighthouse.png");
  writeFileSync(picture, tinyPng());
  const path = write("image-run-0001", [event({ type: "task_started", turn_id: "turn-1" }), ...request("Draw a lighthouse."),
    agentItem("m1", "Making the picture.", "commentary"), assistant("m1", "Making the picture.", "commentary"),
    event({ type: "item_completed", turn_id: "turn-1", item: { type: "Extension", kind: "image_gen.generation", id: "ig_1",
      status: "completed", result: "iVBORw0KGgo=", failure: null, savedPath: join(work, "..", "generated", "ig_1.png") } }),
    agentItem("m2", picture, "final_answer"), assistant("m2", picture, "final_answer"),
    event({ type: "task_complete", turn_id: "turn-1", last_agent_message: picture })]);
  const candidate = parseCodexFile(path)!;
  assert.equal(candidate.session.summary, "Picture saved: lighthouse.png");
  assert.equal(candidate.session.stopped, undefined);
  assert.deepEqual(candidate.pictures, [{ path: picture, source: picture }]);
  const session = scanCodex().sessions.find((item) => item.sessionId === "image-run-0001")!;
  for (const entries of [codexActivity(session), readTranscriptHistory(session)!.entries]) {
    assert.deepEqual(answers(entries), [["message", "Making the picture.", undefined],
      ["tool", "Picture saved: ig_1.png", "success"], ["final", picture, undefined]]);
  }
});

test("an answer only items or the turn's end carry becomes the chat's answer", (t) => {
  const { write } = sessionsRoot(t);
  const items = write("items-only-001", [event({ type: "task_started", turn_id: "turn-1" }), ...request("Summarise the notes."),
    agentItem("m1", "Reading the notes.", "commentary"), agentItem("m2", "Three notes, all done.", "final_answer"),
    event({ type: "task_complete", turn_id: "turn-1", last_agent_message: "Three notes, all done." })]);
  assert.equal(parseCodexFile(items)!.session.summary, "Three notes, all done.");
  const ending = write("turn-end-only1", [event({ type: "task_started", turn_id: "turn-1" }), ...request("Say done."),
    event({ type: "task_complete", turn_id: "turn-1", last_agent_message: "Done." })]);
  assert.equal(parseCodexFile(ending)!.session.summary, "Done.");
  const sessions = scanCodex().sessions;
  const itemsSession = sessions.find((item) => item.sessionId === "items-only-001")!;
  assert.deepEqual(answers(readTranscriptHistory(itemsSession)!.entries), [
    ["message", "Reading the notes.", undefined], ["final", "Three notes, all done.", undefined]]);
  const endingSession = sessions.find((item) => item.sessionId === "turn-end-only1")!;
  assert.deepEqual(answers(codexActivity(endingSession)), [["final", "Done.", undefined]]);
});

test("an older rollout's answer is not repeated by the end of its turn", (t) => {
  const { write } = sessionsRoot(t);
  write("legacy-answer1", [event({ type: "task_started" }), event({ type: "user_message", message: "Count the files." }),
    event({ type: "agent_message", message: "There are four." }),
    event({ type: "task_complete", last_agent_message: "There are four." })]);
  const session = scanCodex().sessions.find((item) => item.sessionId === "legacy-answer1")!;
  assert.deepEqual(codexActivity(session).filter((entry) => entry.kind !== "user").map((entry) => entry.text), ["There are four."]);
  // A page that begins after its turn's start leaves an answer it cannot place to the page above.
  const out: Parameters<typeof appendCodexActivity>[0]["out"] = [];
  appendCodexActivity({ out, seen: new Set(), session, observations: new Map(),
    lines: [JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg",
      payload: { type: "task_complete", last_agent_message: "There are four." } })] });
  assert.deepEqual(out, []);
});

test("a run nobody asked anything is no chat until its request appears", (t) => {
  const { write } = sessionsRoot(t);
  const path = write("no-request-01", [event({ type: "task_started", turn_id: "turn-1" })]);
  assert.equal(scanCodex().sessions.some((item) => item.sessionId === "no-request-01"), false);
  assert.equal(scanCodex().lineage?.some((fact) => fact.sessionId === "no-request-01"), false);
  appendFileSync(path, request("Draw a harbour.").map((row) => JSON.stringify({ timestamp: new Date().toISOString(), ...row })).join("\n") + "\n");
  assert.equal(scanCodex().sessions.find((item) => item.sessionId === "no-request-01")?.title, "Draw a harbour.");
});

test("a request only an item carries names the chat", (t) => {
  const { write } = sessionsRoot(t);
  const path = write("item-request1", [event({ type: "task_started", turn_id: "turn-1" }),
    event({ type: "item_completed", item: { type: "UserMessage", id: "u1", content: [{ type: "text", text: "Tidy the README." }] } })]);
  assert.equal(parseCodexFile(path)!.session.title, "Tidy the README.");
});

test("Codex's retry time is read in this computer's zone, on the day of the error or on the day it names", () => {
  const at = new Date(2026, 10, 17, 9, 30);
  assert.equal(codexRetryAt("or try again at 4:45 PM.", at.getTime()), new Date(2026, 10, 17, 16, 45).getTime());
  assert.equal(codexRetryAt("Try again at 12:05 AM.", at.getTime()), new Date(2026, 10, 17, 0, 5).getTime());
  assert.equal(codexRetryAt("or try again at Nov 18th, 2026 3:00 AM.", at.getTime()), new Date(2026, 10, 18, 3, 0).getTime());
  assert.equal(codexRetryAt("or try again later.", at.getTime()), undefined);
  assert.equal(codexRetryAt("try again at 13:61 PM", at.getTime()), undefined);
  assert.equal(codexRetryAt("try again at Foo 3rd, 2026 1:00 PM", at.getTime()), undefined);
  assert.equal(codexRetryAt(undefined, at.getTime()), undefined);
});

test("a stop keeps Codex's first sentence and names its kind for the phone", () => {
  assert.equal(providerSentence("Unexpected status 502 from https://example.com/v1 (retry later). Then more."),
    "Unexpected status 502 from (retry later).");
  assert.equal(providerSentence("stream disconnected before completion"), "stream disconnected before completion");
  assert.equal(providerSentence(""), undefined);
  assert.equal(providerSentence(42), undefined);
  assert.equal(stopReason("usage_limit_exceeded"), "usage_limit");
  assert.equal(stopReason({ http_connection_failed: { http_status_code: 502 } }), "service");
  assert.equal(stopReason("unauthorized"), "sign_in");
  assert.equal(stopReason("something_new"), "error");
  assert.equal(stopReason(null), "error");
});

test("a limit that reset over an hour ago is a stop without a limit", () => {
  const now = Date.now();
  const stopped = { reason: "usage_limit", message: "You’ve hit your usage limit.", at: now - 3 * 3_600_000 };
  assert.deepEqual(stoppedFields({ stopped, resetsAt: now - 2 * 3_600_000 }, now), { stopped });
  assert.deepEqual(stoppedFields({ stopped, resetsAt: now + 60_000 }, now), { stopped, usageLimit: { resetsAt: now + 60_000 } });
  assert.deepEqual(stoppedFields(undefined, now), {});
  const base = { sessionId: "cached-limit", agent: "codex", state: "idle" as const, startedAt: 1, lastActivityAt: 1,
    tokensSession: 0, tokensLastTurn: 0 };
  assert.equal(withCurrentLimit({ ...base, usageLimit: { resetsAt: now - 2 * 3_600_000 } }, now).usageLimit, undefined);
  assert.ok(withCurrentLimit({ ...base, usageLimit: { resetsAt: now } }, now).usageLimit);
});

test("another error stops the turn with its own reason and no usage limit", (t) => {
  const { write } = sessionsRoot(t);
  const path = write("server-error1", [event({ type: "task_started", turn_id: "turn-1" }), ...request("Draw a bridge."),
    event({ type: "task_complete", turn_id: "turn-1", last_agent_message: null,
      error: { message: "", codex_error_info: { response_stream_disconnected: { http_status_code: null } } } })]);
  const session = parseCodexFile(path)!.session;
  assert.equal(session.summary, "Codex stopped.");
  assert.deepEqual(session.stopped && { reason: session.stopped.reason, message: session.stopped.message }, { reason: "service", message: undefined });
  assert.equal(session.usageLimit, undefined);
  // The next turn clears the stop.
  appendFileSync(path, JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg",
    payload: { type: "task_started", turn_id: "turn-2" } }) + "\n");
  assert.equal(parseCodexFile(path)!.session.stopped, undefined);
});
