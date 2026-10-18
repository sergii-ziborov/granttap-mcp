import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cursorAction } from "../actions";

test("Cursor permission actions retain native file paths and never guess a missing target", () => {
  const action = cursorAction({ kind: "edit", rawInput: { path: "src/main.ts" } }, "/fixture");
  assert.equal(action?.tool, "Edit"); assert.equal(action?.input.file_path, "/fixture/src/main.ts");
  assert.equal(cursorAction({ kind: "edit", rawInput: {} }, "/fixture"), undefined);
  assert.equal(cursorAction({ kind: "execute", rawInput: {} }, "/fixture"), undefined);
  assert.equal(cursorAction({ kind: "other", rawInput: { command: "unknown operation" } }, "/fixture"), undefined);
});

test("Cursor MCP permission identifies the configured server without exposing its arguments", t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-acp-mcp-")), previous = process.env.GRANTTAP_CURSOR_DIR;
  process.env.GRANTTAP_CURSOR_DIR = join(root, "cursor"); mkdirSync(process.env.GRANTTAP_CURSOR_DIR);
  writeFileSync(join(process.env.GRANTTAP_CURSOR_DIR, "mcp.json"), JSON.stringify({ mcpServers: {
    fixture: { command: "fixture-server", env: { KEY: "private-server-value" } } } }));
  t.after(() => { if (previous === undefined) delete process.env.GRANTTAP_CURSOR_DIR; else process.env.GRANTTAP_CURSOR_DIR = previous;
    rmSync(root, { recursive: true, force: true }); });
  const action = cursorAction({ kind: "other", rawInput: { providerIdentifier: "user-fixture", toolName: "inspect",
    args: { secret: "private-argument-value" } } }, root);
  assert.equal(action?.tool, "mcp__fixture__inspect");
  assert.equal(action?.capability?.kind, "mcp");
  assert.equal(action?.capability?.confidence, "exact");
  assert(!action?.details.includes("private-argument-value"));
  assert(!action?.details.includes("private-server-value"));
  assert.equal(cursorAction({ kind: "other", rawInput: { providerIdentifier: "unknown", toolName: "inspect" } }, root), undefined);
});
