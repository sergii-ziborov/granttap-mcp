import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("a Project refusal is written for its chat and read back bounded and in order", async () => {
  process.env.GRANTTAP_CONFIG_DIR = await mkdtemp(join(tmpdir(), "granttap-decisions-"));
  const { recordProjectDecision, recentProjectDecisions } = await import("../apps/bridge/src/policy/decision-log");
  assert.deepEqual(recentProjectDecisions("chat"), [], "nothing refused yet reads as nothing");
  for (let index = 0; index < 60; index += 1) {
    recordProjectDecision("chat", { at: 1_000 + index, toolName: "Bash", reason: `no ${index}`, ruleId: "deny-shell" });
  }
  recordProjectDecision("other-chat/../x", { at: 5, toolName: "Write", reason: "elsewhere" });
  const records = recentProjectDecisions("chat");
  assert.equal(records.length, 50, "the log is bounded");
  assert.equal(records[0]?.reason, "no 10", "the oldest refusals fall off first");
  assert.equal(records.at(-1)?.ruleId, "deny-shell");
  // A chat id is a file name only after it has been made safe.
  assert.deepEqual(recentProjectDecisions("other-chat/../x").map((r) => r.reason), ["elsewhere"]);
});

test("the chat timeline carries the refusal beside what happened", async () => {
  process.env.GRANTTAP_CONFIG_DIR = await mkdtemp(join(tmpdir(), "granttap-decisions-"));
  const { recordProjectDecision } = await import("../apps/bridge/src/policy/decision-log");
  const { scanSessionActivity } = await import("../apps/bridge/src/sessions");
  recordProjectDecision("absent-chat", { at: 2_000, toolName: "Bash", reason: "Project rule deny-shell requires deny", ruleId: "deny-shell" });
  const activity = scanSessionActivity({
    sessionId: "absent-chat", agent: "claude", state: "idle", startedAt: 1, lastActivityAt: 2,
    tokensSession: 0, tokensLastTurn: 0,
  } as never);
  const status = activity.entries.find((entry) => entry.kind === "status");
  assert.ok(status, "a refusal becomes a status row even in a chat with no transcript on disk");
  assert.match(status.text, /Blocked by Project rule deny-shell/);
  assert.equal(status.toolName, "Bash");
});
