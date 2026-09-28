import assert from "node:assert/strict";
import { appendFile, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseCodexFile } from "../parse";

async function rollout(rows: Array<[number, unknown]>) {
  const path = join(await mkdtemp(join(tmpdir(), "granttap-turn-state-")), "rollout.jsonl");
  const first = rows[0]![0];
  await writeFile(path, JSON.stringify({ timestamp: first, type: "session_meta",
    payload: { id: "state-fixture", cwd: "/test" } }) + "\n" +
    rows.map(([timestamp, payload]) => JSON.stringify({ timestamp, type: "event_msg", payload })).join("\n") + "\n");
  const last = rows.at(-1)![0];
  await utimes(path, last / 1000, last / 1000);
  return path;
}

test("an unfinished Codex turn remains working through a long tool wait and cached scans", async () => {
  const path = await rollout([[Date.now() - 10 * 60_000, { type: "task_started", turn_id: "turn" }]]);
  assert.equal(parseCodexFile(path)?.session.state, "working");
  assert.equal(parseCodexFile(path)?.session.state, "working");
});

test("completion and interruption stop working immediately even when the transcript is fresh", async () => {
  for (const type of ["task_complete", "turn_aborted"]) {
    const path = await rollout([[Date.now() - 2000, { type: "task_started" }],
      [Date.now() - 1000, { type }]]);
    assert.equal(parseCodexFile(path)?.session.state, "idle");
    assert.equal(parseCodexFile(path)?.session.state, "idle");
  }
});

test("a resumed turn invalidates completion without minting a new native session", async () => {
  const path = await rollout([[Date.now() - 2000, { type: "task_complete" }]]);
  assert.equal(parseCodexFile(path)?.session.state, "idle");
  await appendFile(path, JSON.stringify({ timestamp: Date.now(), type: "event_msg",
    payload: { type: "task_started", turn_id: "next-turn" } }) + "\n");
  assert.equal(parseCodexFile(path)?.session.state, "working");
  assert.equal(parseCodexFile(path)?.session.sessionId, "state-fixture");
});

test("work in a bounded tail supersedes an old final while token accounting does not", async () => {
  const path = await rollout([[Date.now() - 2000, { type: "task_complete" }]]);
  await appendFile(path, JSON.stringify({ timestamp: Date.now(), type: "event_msg",
    payload: { type: "token_count", info: {} } }) + "\n");
  assert.equal(parseCodexFile(path)?.session.state, "idle");
  await appendFile(path, JSON.stringify({ timestamp: Date.now(), type: "response_item",
    payload: { type: "custom_tool_call", name: "test" } }) + "\n");
  assert.equal(parseCodexFile(path)?.session.state, "working");
  await appendFile(path, JSON.stringify({ timestamp: Date.now() + 1, type: "response_item",
    payload: { type: "message", role: "assistant", channel: "final", content: [] } }) + "\n");
  assert.equal(parseCodexFile(path)?.session.state, "idle");
});
