import assert from "node:assert/strict";
import test from "node:test";
import { transcriptParent } from "../attach";
import { createClaudeLineageCalls, createCodexLineageCalls, type LineageFact } from "../facts";
import { promptLead } from "../headless";

const T0 = Date.parse("2026-11-17T01:46:12.000Z");
const NOW = T0 + 60 * 60_000;
const PARENT = "38034755-03a1-429d-8db6-2aa351e64a0b";
const iso = (at: number) => new Date(at).toISOString();
const TEMPLATE = "Use your image_gen tool to generate one editorial illustration for a blog article about job search:";

/** A Claude chat that ran a loop of `codex exec` in the background, then one more in the foreground. */
function claudeParent(): LineageFact {
  const calls = createClaudeLineageCalls();
  const rows = [
    { type: "assistant", timestamp: iso(T0), message: { content: [{ type: "tool_use", id: "toolu_loop", name: "Bash",
      input: { run_in_background: true, command: `cd /tmp/blogart && for topic in "$@"; do\n  codex exec "${TEMPLATE} $topic. Save it as a PNG." ; done` } }] } },
    { type: "user", timestamp: iso(T0 + 600), toolUseResult: { backgroundTaskId: "b7x1q2w3e" },
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_loop", content: "Command running in background with ID: b7x1q2w3e" }] } },
    { type: "assistant", timestamp: iso(T0 + 20_000), message: { content: [{ type: "tool_use", id: "toolu_ls", name: "Bash", input: { command: "ls /tmp/blogart" } }] } },
    { type: "queue-operation", operation: "enqueue", timestamp: iso(T0 + 586_000),
      content: "<task-notification>\n<task-id>b7x1q2w3e</task-id>\n<tool-use-id>toolu_loop</tool-use-id>\n<status>completed</status>\n</task-notification>" },
    { type: "user", timestamp: iso(T0 + 586_100), message: { content: "<task-notification><tool-use-id>toolu_loop</tool-use-id><status>completed</status></task-notification>" } },
    { type: "assistant", timestamp: iso(T0 + 630_000), message: { content: [{ type: "tool_use", id: "toolu_one", name: "Bash",
      input: { command: `codex exec "Use your image_gen tool to generate a wide banner of a lighthouse at dusk over a calm sea, no text."` } }] } },
    { type: "user", timestamp: iso(T0 + 744_000), message: { content: [{ type: "tool_result", tool_use_id: "toolu_one", content: "done" }] } },
  ];
  for (const row of rows) calls.add(row);
  return { agent: "claude", sessionId: PARENT, cwd: "/Users/me/dev/applydjin", startedAt: T0 - 3_600_000, calls: calls.snapshot() };
}

function child(id: string, at: number, prompt: string, extra: Partial<LineageFact> = {}): LineageFact {
  return { agent: "codex", sessionId: id, cwd: "/tmp/blogart", startedAt: at, headless: true, prompt: promptLead(prompt), ...extra };
}

test("the transcript shows each command's window, a background one until Claude's notification", () => {
  const { calls } = claudeParent();
  assert.deepEqual(calls?.map((call) => [call.targets, call.startedAt - T0, call.endedAt! - T0]),
    [[["codex"], 0, 586_000], [["codex"], 630_000, 744_000]], "a command that starts no provider is not kept");
  assert.ok(calls![0]!.command.startsWith("cd /tmp/blogart && for topic in $@; do codex exec Use your image_gen tool"));
});

test("a child is matched to the chat whose running command carried its request, templated or whole", () => {
  const parent = claudeParent();
  const templated = child("01a1e72e-e724-7e42-b71b-646abde999a3", T0 + 1_700,
    `${TEMPLATE} a candidate reading a rejection letter at a kitchen table. Save it as a PNG.`);
  const later = child("01a1e737-52d5-7403-a832-e54fb152f860", T0 + 553_000, `${TEMPLATE} a handshake. Save it as a PNG.`);
  const whole = child("01a1e738-89aa-71f0-8d65-f85cf9e446e4", T0 + 632_000,
    "Use your image_gen tool to generate a wide banner of a lighthouse at dusk over a calm sea, no text.");
  for (const item of [templated, later, whole]) {
    assert.deepEqual(transcriptParent(item, [parent, item], NOW), { agent: "claude", sessionId: PARENT }, item.sessionId);
  }
});

test("a similar request outside the command's window, a short one, or one on another computer is not matched", () => {
  const parent = claudeParent();
  const prompt = `${TEMPLATE} a handshake. Save it as a PNG.`;
  const cases: Array<[string, LineageFact]> = [
    ["started before the command", child("before-the-loop-01", T0 - 60_000, prompt)],
    ["started after the loop finished", child("after-the-loop-001", T0 + 586_000 + 30_000, prompt)],
    ["short request", child("short-request-0001", T0 + 2_000, "Use your image_gen tool")],
    ["another computer", child("elsewhere-00000001", T0 + 2_000, prompt, { computerId: "other-mac" })],
    ["a person's own session", child("typed-by-a-person", T0 + 2_000, prompt, { headless: false })],
    ["another provider", child("grok-run-00000001", T0 + 2_000, prompt, { agent: "grok" })],
    ["a different request", child("different-req-001", T0 + 2_000, "Use your image_gen tool to draw a different picture of the sea entirely")],
    ["too old to look for", child("long-ago-00000001", T0 + 2_000, prompt)],
  ];
  for (const [label, item] of cases) {
    const now = label === "too old to look for" ? T0 + 3 * 24 * 60 * 60_000 : NOW;
    assert.equal(transcriptParent(item, [parent, item], now), undefined, label);
  }
});

test("a child two chats could have started, or one that would name itself, is left unlinked", () => {
  const parent = claudeParent();
  const twin: LineageFact = { ...parent, sessionId: "another-chat-running-the-same-loop" };
  const item = child("01a1e72e-e724-7e42-b71b-646abde999a3", T0 + 1_700, `${TEMPLATE} a desk. Save it as a PNG.`);
  assert.equal(transcriptParent(item, [parent, twin, item], NOW), undefined);
  const self: LineageFact = { ...parent, agent: "codex", sessionId: item.sessionId, startedAt: item.startedAt, headless: true, prompt: item.prompt };
  assert.equal(transcriptParent(self, [self], NOW), undefined, "a session is never its own parent");
  const younger: LineageFact = { ...parent, startedAt: item.startedAt + 1 };
  assert.equal(transcriptParent(item, [younger, item], NOW), undefined, "a parent exists before its child");
});

test("a Codex chat's command is read from exec_command, shell and code-mode exec calls until their output", () => {
  const calls = createCodexLineageCalls();
  const at = (offset: number) => iso(T0 + offset);
  calls.add({ type: "response_item", timestamp: at(0), payload: { type: "function_call", name: "exec_command", call_id: "c1",
    arguments: JSON.stringify({ cmd: `claude -p "Summarise the release notes for the next version in three short bullet points"`, workdir: "/tmp/x" }) } });
  calls.add({ type: "response_item", timestamp: at(5_000), payload: { type: "function_call_output", call_id: "c1", output: "ok" } });
  calls.add({ type: "response_item", timestamp: at(6_000), payload: { type: "custom_tool_call", name: "exec", call_id: "c2",
    input: `await tools.exec_command({cmd: "grok -p \\"Draw a lighthouse at dusk over a calm sea with gulls overhead\\""})` } });
  calls.add({ type: "response_item", timestamp: at(7_000), payload: { type: "custom_tool_call_output", call_id: "c2",
    output: [{ type: "input_text", text: "Process running with session ID 41" }] } });
  calls.add({ type: "response_item", timestamp: at(8_000), payload: { type: "function_call", name: "shell", call_id: "c3",
    arguments: JSON.stringify({ command: ["bash", "-lc", "codex exec 'Write a limerick about tests'"] }) } });
  calls.add({ type: "response_item", timestamp: at(9_000), payload: { type: "function_call", name: "exec_command", call_id: "c4",
    arguments: JSON.stringify({ cmd: "git status" }) } });
  calls.add({ type: "response_item", timestamp: at(9_500), payload: { type: "function_call", name: "exec_command", call_id: "c5", arguments: "{" } });
  assert.deepEqual(calls.snapshot().map((call) => [call.targets, call.startedAt - T0, call.endedAt === undefined ? "open" : call.endedAt - T0]),
    [[["claude"], 0, 5_000], [["grok"], 6_000, "open"], [["codex"], 8_000, "open"]],
    "a process still running keeps its call open; a command that starts no provider is not kept");
  const parent: LineageFact = { agent: "codex", sessionId: "codex-parent-0001", startedAt: T0 - 1_000, calls: calls.snapshot() };
  const grok: LineageFact = { agent: "grok", sessionId: "grok-child-000001", startedAt: T0 + 60_000, headless: true,
    prompt: promptLead("Draw a lighthouse at dusk over a calm sea with gulls overhead") };
  assert.deepEqual(transcriptParent(grok, [parent, grok], T0 + 120_000), { agent: "codex", sessionId: "codex-parent-0001" },
    "a call still running is open for its child");
});
