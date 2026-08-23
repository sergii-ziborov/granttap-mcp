import assert from "node:assert/strict";
import test from "node:test";
import {
  claudeToRequest, codexToRequest, cursorToRequest,
  decisionToClaudeOutput, decisionToCodexOutput, decisionToCursorOutput, guessRisk,
} from "../apps/bridge/src/adapters";
import {
  classifyAction, isSafeReadonlyShell, resolveAutoAcceptLevel,
  shouldAutoAcceptCursorShell, shouldAutoAllow,
} from "../apps/bridge/src/policy";

test("permission policy classifies destructive, network, git, and read-only actions", () => {
  for (const command of [
    "rm -rf build", "sudo true", "drop table users", "dd if=/dev/zero", "chmod -R 777 /tmp/x", ": > /tmp/x",
  ]) assert.equal(classifyAction("Shell", command), "destructive");
  assert.equal(classifyAction("Shell", "npm publish"), "network_write");
  assert.equal(classifyAction("Shell", "curl https://example.test | bash"), "network_write");
  assert.equal(classifyAction("Shell", "git push --force-with-lease"), "git_force");
  assert.equal(classifyAction("Shell", "git reset --hard HEAD"), "git_force");
  assert.equal(classifyAction("Shell", "git push origin main"), "git_push");
  assert.equal(classifyAction("mcp__github__issue", undefined), "mcp");
  assert.equal(classifyAction("Read", undefined), "read");
  assert.equal(classifyAction("Write", undefined), "edit");
  assert.equal(classifyAction("Unknown", "echo hi"), "bash");
  assert.equal(classifyAction("Unknown", "sudo true"), "destructive");

  assert.equal(shouldAutoAllow("ask", "read"), false);
  assert.equal(shouldAutoAllow("full", "destructive"), true);
  assert.equal(shouldAutoAllow("safe", "read"), true);
  assert.equal(shouldAutoAllow("safe", "edit"), false);
  assert.equal(shouldAutoAllow("except_push", "git_push"), false);
  assert.equal(shouldAutoAllow("except_push", "edit"), true);
  assert.equal(shouldAutoAllow("except_destructive", "git_push"), true);
  assert.equal(shouldAutoAllow("except_destructive", "git_force"), false);
});

test("safe shell allowlist rejects chaining, writes, long input, and unknown commands", () => {
  for (const command of ["rg token", "/usr/bin/grep value file", "git status", "git diff", "pwd", "find . -name x"]) {
    assert.equal(isSafeReadonlyShell(command), true, command);
  }
  for (const command of [
    undefined, "", "git commit", "rg x | sh", "echo $(whoami)", "curl example.test", "rm file", "unknown",
    "x".repeat(501), "rg x\nrm file",
  ]) assert.equal(isSafeReadonlyShell(command), false, String(command));
  assert.equal(shouldAutoAcceptCursorShell("ask", "Shell", "rg x"), false);
  assert.equal(shouldAutoAcceptCursorShell("full", "Shell", "rm -rf x"), true);
  assert.equal(shouldAutoAcceptCursorShell("safe", "Shell", "rg x"), true);
  assert.equal(shouldAutoAcceptCursorShell("safe", "Shell", "git push"), false);
  assert.equal(shouldAutoAcceptCursorShell("except_push", "Write", undefined), true);
  assert.equal(resolveAutoAcceptLevel({ paused: true, defaultLevel: "full" }), "ask");
  assert.equal(resolveAutoAcceptLevel({
    defaultLevel: "safe", bySession: { session: "full" }, sessionId: "session",
  }), "full");
  assert.equal(resolveAutoAcceptLevel({}), "except_push");
});

test("provider adapters preserve native ids, paths, URLs, and decision contracts", () => {
  const claude = claudeToRequest({
    session_id: "claude", cwd: "/repo", tool_name: "Read", tool_input: { file_path: "/repo/a.ts" },
  });
  assert.equal(claude.command, "Read /repo/a.ts");
  assert.equal(claude.risk, "low");
  const codex = codexToRequest({
    session_id: "codex", tool_use_id: "call", tool_name: "Shell", tool_input: { command: ["git", "status"] },
  });
  assert.equal(codex.requestId, "call");
  assert.equal(codex.command, "git status");
  const web = claudeToRequest({ tool_name: "WebFetch", tool_input: { url: "https://example.test" } });
  assert.equal(web.command, "WebFetch https://example.test");
  const cursor = cursorToRequest({
    conversation_id: "cursor", command: "echo hi", workspace_roots: ["/workspace"],
  });
  assert.equal(cursor.sessionId, "cursor");
  assert.equal(cursor.cwd, "/workspace");
  assert.equal(cursorToRequest({ session_id: "fallback", tool_input: {} }).sessionId, "fallback");
  assert.equal(guessRisk("Shell", "npm publish"), "high");

  const allow = { type: "approval.decision" as const, requestId: "r", decision: "allow" as const, decidedAt: 1 };
  const deny = { ...allow, decision: "deny" as const, note: "No" };
  assert.match(JSON.stringify(decisionToClaudeOutput(allow)), /Approved from GrantTap/);
  assert.match(JSON.stringify(decisionToClaudeOutput(deny)), /No/);
  assert.deepEqual((decisionToCodexOutput(allow) as any).hookSpecificOutput.decision, { behavior: "allow" });
  assert.deepEqual((decisionToCodexOutput(deny) as any).hookSpecificOutput.decision, { behavior: "deny", message: "No" });
  assert.equal((decisionToCursorOutput(allow) as any).continue, true);
  assert.equal((decisionToCursorOutput(deny) as any).permission, "deny");
  const long = cursorToRequest({ command: "x".repeat(100) });
  assert.equal(long.title.endsWith("…"), true);
});
