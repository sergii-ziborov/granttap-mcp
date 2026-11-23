import assert from "node:assert/strict";
import test from "node:test";
import { CapabilityUsageEvent } from "../../../../../../packages/protocol/schema";
import { pendingCapabilityObservation, toObservedCapability, toRemoteCapabilityUsageEvent } from "..";
import { inputPreviewFromInput, MAX_INPUT_PREVIEW_LENGTH } from "../command-preview";

test("an MCP call's arguments read as one short line, long values cut and nested ones elided", () => {
  assert.equal(inputPreviewFromInput({ code: "await hostwatch.deployments.list()", limit: 5, dry: true }),
    "code: await hostwatch.deployments.list(), limit: 5, dry: true");
  assert.equal(inputPreviewFromInput({ items: ["a", "b", "c"], one: ["web-1"], options: { deep: 1 } }),
    "items: [3 items], one: [web-1], options: {…}");
  const long = inputPreviewFromInput({ query: "x".repeat(5_000), second: "y".repeat(5_000) })!;
  assert.ok(long.length <= MAX_INPUT_PREVIEW_LENGTH);
  assert.ok(long.startsWith(`query: ${"x".repeat(60)}…`));
  assert.equal(inputPreviewFromInput({}), null);
  assert.equal(inputPreviewFromInput(undefined), null);
});

test("secrets an MCP call or a skill was given never reach the phone", () => {
  const preview = inputPreviewFromInput({ host: "web-1", password: "hunter2-synthetic", api_key: "synthetic-key",
    url: "https://user:synthetic-pass@example.test/x", note: "token=synthetic-token" })!;
  for (const secret of ["hunter2-synthetic", "synthetic-key", "synthetic-pass", "synthetic-token"]) {
    assert.equal(preview.includes(secret), false, preview);
  }
  assert.ok(preview.startsWith("host: web-1"));
});

test("MCP and skill observations carry the preview to the chat and to Usage; a shell call keeps its command", () => {
  const mcp = pendingCapabilityObservation({ sourceId: "call-1", sessionId: "chat-1", createdAt: 1,
    toolName: "mcp__gethostwatch__execute", input: { code: "hostwatch.servers.list()" } })!;
  assert.equal(mcp.inputPreview, "code: hostwatch.servers.list()");
  assert.equal(toObservedCapability(mcp).inputPreview, "code: hostwatch.servers.list()");
  const event = toRemoteCapabilityUsageEvent(mcp)!;
  assert.equal(event.inputPreview, "code: hostwatch.servers.list()");
  assert.equal(CapabilityUsageEvent.parse(event).inputPreview, "code: hostwatch.servers.list()");

  const skill = pendingCapabilityObservation({ sourceId: "call-2", sessionId: "chat-1", createdAt: 1,
    toolName: "Skill", input: { skill: "pdf", args: "merge report.pdf" } })!;
  assert.equal(toRemoteCapabilityUsageEvent(skill)!.inputPreview, "skill: pdf, args: merge report.pdf");

  const shell = pendingCapabilityObservation({ sourceId: "call-3", sessionId: "chat-1", createdAt: 1,
    toolName: "Bash", input: { command: "git status" } })!;
  assert.equal(shell.inputPreview, undefined);
  assert.equal(toRemoteCapabilityUsageEvent(shell)!.commandPreview, "git status");
});
