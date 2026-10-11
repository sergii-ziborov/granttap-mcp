import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { codexActivity, scanCodex } from "..";
import { readTranscriptHistory } from "../../../../transcript-history";

const pageContext = '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>';

function fixture(t: TestContext, id: string, messages: string[], nativeTitle?: string) {
  const root = mkdtempSync(join(tmpdir(), "granttap-codex-host-context-"));
  const day = join(root, "2026", "10", "11");
  mkdirSync(day, { recursive: true });
  const previous = process.env.GRANTTAP_CODEX_SESSIONS_DIR;
  process.env.GRANTTAP_CODEX_SESSIONS_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_CODEX_SESSIONS_DIR;
    else process.env.GRANTTAP_CODEX_SESSIONS_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const rows: unknown[] = [{ type: "session_meta", timestamp: new Date(1000).toISOString(),
    payload: { id, cwd: root, ...(nativeTitle ? { title: nativeTitle } : {}) } }];
  for (const [index, message] of messages.entries()) {
    const timestamp = new Date(2000 + index).toISOString();
    rows.push({ type: "event_msg", timestamp, payload: { type: "user_message", message } });
    rows.push({ type: "response_item", timestamp, payload: {
      type: "message", role: "user", content: [{ type: "input_text", text: message }],
    } });
  }
  writeFileSync(join(day, `rollout-${id}.jsonl`), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  return scanCodex().sessions.find(session => session.sessionId === id)!;
}

test("Codex selected-page metadata never becomes the chat title or a history message", t => {
  const session = fixture(t, "page-context", [pageContext, "Fix the account connection"]);
  assert.equal(session.title, "Fix the account connection");
  for (const entries of [codexActivity(session), readTranscriptHistory(session)!.entries]) {
    assert.ok(entries.some(entry => entry.text === "Fix the account connection"));
    assert.equal(entries.some(entry => entry.text.includes("page_id")), false);
  }
  assert.equal(scanCodex().sessions[0]?.title, "Fix the account connection");
});

test("Codex retains the person's text alongside selected-page context", t => {
  const request = "Explain the graph";
  const session = fixture(t, "page-and-request", [pageContext + "\n\n" + request]);
  assert.equal(session.title, request);
  assert.ok(readTranscriptHistory(session)!.entries.every(entry => entry.text === request));
});

test("Codex ordinary JSON requests remain visible and can name a chat", t => {
  const request = '{"page_id":null}';
  const session = fixture(t, "json-request", [request]);
  assert.equal(session.title, request);
  assert.ok(readTranscriptHistory(session)!.entries.every(entry => entry.text === request));
});

test("Codex context-only conversations do not expose a synthetic user message", t => {
  const session = fixture(t, "context-only", [pageContext]);
  assert.equal(session.title, undefined);
  assert.deepEqual(codexActivity(session), []);
  assert.deepEqual(readTranscriptHistory(session)!.entries, []);
});

test("Codex wrapped metadata titles fall back to the real request", t => {
  const session = fixture(t, "wrapped-title", [pageContext, "Review the release"], pageContext);
  assert.equal(session.title, "Review the release");
});

test("Codex preserves quoted host markup in an actual request", t => {
  const request = "Explain this transcript example: " + pageContext;
  const session = fixture(t, "quoted-context", [request]);
  assert.ok(readTranscriptHistory(session)!.entries.every(entry => entry.text === request));
});

test("Codex drops consecutive host blocks and incomplete context-only rows", t => {
  const session = fixture(t, "repeated-context", [
    '<external_codex_apps_open_page>{"page_id":null}',
    pageContext + "\n" + pageContext + "\nContinue the task",
  ]);
  assert.equal(session.title, "Continue the task");
  assert.ok(readTranscriptHistory(session)!.entries.every(entry => entry.text === "Continue the task"));
});
