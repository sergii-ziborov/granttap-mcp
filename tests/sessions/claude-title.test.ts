import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseClaudeFile } from "../../apps/bridge/src/sessions/scan/claude/parse";

function titleOf(rows: unknown[]): string | undefined {
  const directory = mkdtempSync(join(tmpdir(), "granttap-claude-title-"));
  try {
    const file = join(directory, "claude.jsonl");
    writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    return parseClaudeFile(file)?.session?.title;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const at = new Date(Date.now() - 60_000).toISOString();
const user = (content: unknown) => ({ sessionId: "claude-title", type: "user", timestamp: at,
  message: { role: "user", content } });

test("a chat opened with pasted text is named by that text, not by its wrapper", () => {
  const title = titleOf([user("<pasted_content id=\"2ebe\">\nRepair the lock screen title\nmore context\n</pasted_content>")]);
  assert.equal(title, "Repair the lock screen title more context");
});

test("a host note before the first typed message does not name the chat", () => {
  const title = titleOf([
    user("<system-reminder>context the host added</system-reminder>"),
    user([{ type: "text", text: "<pasted_content id=\"a1\">Ship the site</pasted_content>" }]),
  ]);
  assert.equal(title, "Ship the site");
});
