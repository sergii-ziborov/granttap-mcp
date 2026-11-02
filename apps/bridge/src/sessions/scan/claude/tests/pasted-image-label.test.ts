import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ActivityEntry, SessionInfo } from "../../../../../../../packages/protocol/schema";
import { appendClaudeActivity, claudeChildSummary } from "..";
import { parseClaudeFile } from "../parse";

const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
const label = { type: "text", text: "[Image: source: /private/tmp/claude-shot/Screenshot 1.png]" };

function rows(content: unknown[]): string[] {
  return [JSON.stringify({ type: "user", sessionId: "pasted", cwd: "/tmp", uuid: "u-1",
    timestamp: new Date(1_000).toISOString(), message: { role: "user", content } })];
}

function chat(content: unknown[]): ActivityEntry[] {
  const session = { sessionId: "pasted", agent: "claude", lastActivityAt: 1_000 } as SessionInfo;
  const out: ActivityEntry[] = [];
  appendClaudeActivity({ out, seen: new Set(), session, lines: rows(content), observations: new Map() });
  return out;
}

test("Claude's label for a pasted image is not a chat message, a title, or a child title", t => {
  const pasted = chat([label, { type: "text", text: "[Image #1]\n[Image #2]" }, image]);
  assert.deepEqual(pasted.map(entry => [entry.text, entry.attachments]), [["Image", ["Image"]]]);

  const root = mkdtempSync(join(tmpdir(), "granttap-claude-image-label-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "pasted.jsonl");
  writeFileSync(file, [...rows([label, image]), JSON.stringify({ type: "user", sessionId: "pasted",
    timestamp: new Date(2_000).toISOString(), message: { role: "user", content: "make it blue" } })].join("\n"));
  assert.equal(parseClaudeFile(file)!.session.title, "make it blue");
  assert.equal(claudeChildSummary(file, "parent", rows([label, image])).title, undefined);
});

test("the person's words beside a pasted image, and a label without an image, stay visible", () => {
  assert.deepEqual(chat([{ type: "text", text: "why is [Image #1] red?" }, image]).map(entry => entry.text),
    ["why is [Image #1] red?", "Image"]);
  assert.deepEqual(chat([{ type: "text", text: "[Image #1]\nfix this" }, image]).map(entry => entry.text),
    ["[Image #1]\nfix this", "Image"]);
  assert.deepEqual(chat([label]).map(entry => entry.text), [label.text]);
});
