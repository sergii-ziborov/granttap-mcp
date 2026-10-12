import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { questionRequest, claudeQuestionOutput } from "..";
import { registerPendingApproval, acceptApprovalDecision, resolvedApprovalOutcome } from "../../approvals/state";

test("Claude questions preserve all options and return selection, multi-select and Other to the original tool", t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-question-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => { if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous; rmSync(root, { recursive: true }); });
  const input = { session_id: "chat", tool_use_id: "question", tool_name: "AskUserQuestion",
    tool_input: { questions: [
      { question: "Which platform?", header: "Platform", options: [
        { label: "App Store", description: "Sandboxed" }, { label: "Website", description: "Direct" } ], multiSelect: false },
      { question: "Which checks?", header: "Checks", options: [
        { label: "Phone", description: "Device" }, { label: "Mac", description: "Desktop" } ], multiSelect: true },
    ] } };
  const request = questionRequest(input)!;
  assert.equal(request.kind, "question");
  assert.deepEqual(request.questions, input.tool_input.questions);
  assert.equal(request.sessionId, "chat");
  registerPendingApproval(request);
  const base = { type: "approval.decision" as const, requestId: request.requestId,
    sessionId: "chat", decision: "allow" as const, decidedAt: Date.now() };
  assert.equal(acceptApprovalDecision(base).matched, false, "A generic Allow cannot answer a question");
  assert.equal(acceptApprovalDecision({ ...base, note: '{"Which platform?":"Website"}' }).matched, false);
  const answers = { "Which platform?": "My own distribution", "Which checks?": "Phone, Mac" };
  const decision = { ...base, note: JSON.stringify(answers) };
  assert.equal(acceptApprovalDecision(decision).matched, true);
  assert.equal(resolvedApprovalOutcome(request.requestId, "chat")?.kind, "decision");
  const output = claudeQuestionOutput(input, decision);
  assert.equal(output?.hookSpecificOutput.permissionDecision, "allow");
  assert.deepEqual(output?.hookSpecificOutput.updatedInput, { ...input.tool_input, answers });
  assert.equal(claudeQuestionOutput(input, base), undefined);
  assert.equal(questionRequest({ ...input, tool_input: { questions: [] } }), undefined);
});
