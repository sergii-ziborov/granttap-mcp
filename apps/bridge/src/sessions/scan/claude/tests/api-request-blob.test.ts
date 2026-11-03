import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ActivityEntry, SessionInfo } from "../../../../../../../packages/protocol/schema";
import { appendClaudeActivity, claudeChildSummary } from "..";
import { parseClaudeFile } from "../parse";

// The shape Claude Code journals after ToolSearch loads a deferred tool.
const requestCopy = JSON.stringify({ type: "api-request-blob", sessionId: "blob", hash: "94bec884",
  message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "tool_reference", tool_name: "TaskStop" }] },
    { type: "text", text: "Tool loaded." }] } });
const asked = JSON.stringify({ type: "user", sessionId: "blob", cwd: "/tmp", uuid: "u-1",
  timestamp: new Date(1_000).toISOString(), message: { role: "user", content: "build the app" } });

test("a copy of an API request is neither a message, a chat title nor a child title", t => {
  const session = { sessionId: "blob", agent: "claude", lastActivityAt: 1_000 } as SessionInfo;
  const out: ActivityEntry[] = [];
  appendClaudeActivity({ out, seen: new Set(), session, lines: [asked, requestCopy], observations: new Map() });
  assert.deepEqual(out.map(entry => entry.text), ["build the app"]);

  const root = mkdtempSync(join(tmpdir(), "granttap-claude-request-copy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "blob.jsonl");
  writeFileSync(file, [requestCopy, asked].join("\n"));
  assert.equal(parseClaudeFile(file)!.session.title, "build the app");
  assert.equal(claudeChildSummary(file, "parent", [requestCopy]).title, undefined);
});
