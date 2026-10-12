import { createHash } from "node:crypto";
import type { ApprovalDecision, ApprovalRequest } from "../../../../packages/protocol/schema";
import { ApprovalQuestions, questionAnswers } from "../../../../packages/protocol/messages/approval-questions";
import { claudeToRequest, type HookInput } from "../host/adapters";

export function questionRequest(input: HookInput): ApprovalRequest | undefined {
  if (input.tool_name !== "AskUserQuestion") return undefined;
  const questions = ApprovalQuestions.safeParse(input.tool_input?.questions);
  if (!questions.success) return undefined;
  const base = claudeToRequest(input);
  if (input.tool_use_id) base.requestId = "claude-question-" + createHash("sha256")
    .update(JSON.stringify([input.session_id, input.tool_use_id, input.tool_input])).digest("hex").slice(0, 24);
  return { ...base, kind: "question", questions: questions.data,
    title: questions.data[0]!.question, risk: "low", command: undefined };
}

/** Preserve the original tool input; supply only the human's explicit answers. */
export function claudeQuestionOutput(input: HookInput, decision: ApprovalDecision,
  request = questionRequest(input)) {
  if (!request || decision.decision !== "allow" || decision.requestId !== request.requestId
    || decision.sessionId !== request.sessionId) return undefined;
  const answers = questionAnswers(request.questions, decision.note);
  if (!answers) return undefined;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
    updatedInput: { ...input.tool_input, questions: input.tool_input!.questions, answers } } };
}
