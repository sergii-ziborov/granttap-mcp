import assert from "node:assert/strict";
import test from "node:test";
import type { ActivityEntry, SessionInfo } from "../../../../../../../../packages/protocol/schema";
import { appendClaudeActivity } from "../..";

const session = { sessionId: "failed-calls", agent: "claude", lastActivityAt: 5_000 } as SessionInfo;
const at = (ms: number) => new Date(ms).toISOString();
const call = (id: string, command: string, ms: number) => JSON.stringify({ type: "assistant", sessionId: session.sessionId,
  uuid: `a-${id}`, timestamp: at(ms), message: { role: "assistant", content: [
    { type: "tool_use", id, name: "Bash", input: { command, description: `Synthetic ${id}` } }] } });
const answer = (id: string, content: unknown, failed: boolean, ms: number) => JSON.stringify({ type: "user",
  sessionId: session.sessionId, uuid: `u-${id}`, timestamp: at(ms), message: { role: "user", content: [
    { type: "tool_result", tool_use_id: id, content, ...(failed ? { is_error: true } : {}) }] } });

function entries(lines: string[]): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  appendClaudeActivity({ out, seen: new Set(), session, lines, observations: new Map() });
  return out.filter(entry => entry.kind === "tool");
}

test("a failed call says what went wrong when it is opened on the phone, a call that worked keeps its output", () => {
  const refusal = "PreToolUse:Bash hook error: GrantTap protects its local pairing, key, and policy files.";
  const [refused, missing, worked] = entries([
    call("toolu_hook", "cat ~/.granttap/attachments/spec.md", 1_000),
    answer("toolu_hook", refusal, true, 1_400),
    call("toolu_missing", "ls /no/such/folder", 2_000),
    answer("toolu_missing", [{ type: "text", text: "Exit code 1\nls: /no/such/folder: No such file or directory\n"
      + "GRANTTAP_TOKEN=sk-ant-api03-SYNTHETICSECRETVALUE0123456789abcdef" }], true, 2_300),
    call("toolu_ok", "echo synthetic", 3_000),
    answer("toolu_ok", "synthetic", false, 3_100),
  ]);
  assert.equal(refused?.resultText, refusal);
  assert.match(missing?.resultText ?? "", /^Exit code 1\nls: \/no\/such\/folder: No such file or directory/);
  assert.doesNotMatch(missing?.resultText ?? "", /SYNTHETICSECRETVALUE/, "a secret in the error never reaches the phone");
  assert.equal(worked?.resultText, undefined, "only what went wrong is sent");
  assert.equal(refused?.createdAt, 1_000, "each step says when it started");
});

test("a long error is cut and says so", () => {
  const [entry] = entries([call("toolu_long", "make", 1_000), answer("toolu_long", "x".repeat(9_000), true, 2_000)]);
  assert.equal(entry?.resultText?.length, 4_000);
  assert.equal(entry?.detailTruncated, true);
});
