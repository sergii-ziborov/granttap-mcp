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

test("a chat keeps the name Claude shows: the person's latest, then Claude's, then the first message", () => {
  const opening = user("почему то просто дико глючит");
  const generated = { type: "ai-title", aiTitle: "Fix flicker on the phone", sessionId: "claude-title" };
  const named = (customTitle: string) => ({ type: "custom-title", customTitle, sessionId: "claude-title" });
  assert.equal(titleOf([opening]), "почему то просто дико глючит");
  assert.equal(titleOf([opening, generated]), "Fix flicker on the phone");
  assert.equal(titleOf([opening, generated, named("Приложение глючит"), named("Приложение глючит на телефоне")]),
    "Приложение глючит на телефоне");
  assert.equal(titleOf([opening, named("  "), generated]), "Fix flicker on the phone");
});

test("a host note before the first typed message does not name the chat", () => {
  const title = titleOf([
    user("<system-reminder>context the host added</system-reminder>"),
    user([{ type: "text", text: "<pasted_content id=\"a1\">Ship the site</pasted_content>" }]),
  ]);
  assert.equal(title, "Ship the site");
});

test("a Claude chat reports the reasoning effort of its latest request, wherever it was started", () => {
  const request = (effort: string, extra: Record<string, unknown> = {}) => ({ type: "api-request", sessionId: "claude-title",
    timestamp: at, querySource: "repl_main_thread", params: { model: "claude-opus-5-5", output_config: { effort } }, ...extra });
  const parse = (rows: unknown[]) => {
    const directory = mkdtempSync(join(tmpdir(), "granttap-claude-effort-"));
    try {
      const file = join(directory, "claude.jsonl");
      writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      return parseClaudeFile(file)?.session;
    } finally { rmSync(directory, { recursive: true, force: true }); }
  };
  assert.equal(parse([user("Start")])?.effort, undefined, "a chat that sent no request yet reports none");
  assert.equal(parse([user("Start"), request("medium"), request("xhigh")])?.effort, "xhigh", "the latest request counts");
  assert.equal(parse([user("Start"), request("high"), request("max", { isSidechain: true })])?.effort, "high",
    "an agent's request inside the chat does not change the chat's own effort");
  assert.equal(parse([user("Start"), request("high"), request("sideways")])?.effort, "high", "an unknown level is ignored");
});
