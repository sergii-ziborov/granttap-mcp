import { createHash } from "node:crypto";
import { z } from "zod";
import type { ApprovalDecision, ApprovalRequest } from "../../../../../packages/protocol/schema";
import { questionAnswers } from "../../../../../packages/protocol/messages/approval-questions";

const identifier = z.string().min(1).max(256);
const choice = z.object({ id: identifier, label: z.string().min(1).max(512) });
export const CursorQuestions = z.object({ toolCallId: identifier, title: z.string().max(160).optional(),
  questions: z.array(z.object({ id: identifier, prompt: z.string().min(1).max(2_000),
    options: z.array(choice).min(1).max(8), allowMultiple: z.boolean().optional() }))
    .min(1).max(4),
}).superRefine((input, context) => {
  if (new Set(input.questions.map(q => q.id)).size !== input.questions.length
    || new Set(input.questions.map(q => q.prompt)).size !== input.questions.length
    || input.questions.some(q => new Set(q.options.map(o => o.id)).size !== q.options.length
      || new Set(q.options.map(o => o.label)).size !== q.options.length)) {
    context.addIssue({ code: "custom", message: "Cursor questions need distinct identities and choices" });
  }
});

export type CursorInteractionScope = { sessionId: string; nativeSessionId?: string; cwd: string };

export function cursorInteractionId(kind: string, scope: CursorInteractionScope, nonce: string, input: unknown): string {
  return "cursor-" + kind + "-" + createHash("sha256")
    .update(JSON.stringify([nonce, scope.sessionId, scope.cwd, input])).digest("hex").slice(0, 32);
}

export function cursorQuestionRequest(raw: unknown, scope: CursorInteractionScope, nonce: string): ApprovalRequest {
  const input = CursorQuestions.parse(raw);
  return { type: "approval.request", requestId: cursorInteractionId("question", scope, nonce, input),
    agent: "cursor", kind: "question", tool: "AskQuestion", title: input.title ?? input.questions[0]!.prompt,
    questions: input.questions.map(question => ({ question: question.prompt, header: input.title?.slice(0, 64) ?? "",
      options: question.options.map(option => ({ label: option.label, description: "" })),
      multiSelect: question.allowMultiple === true })),
    sessionId: scope.sessionId, cwd: scope.cwd, risk: "low", createdAt: Date.now() };
}

function selectedChoices(answer: string, options: z.infer<typeof choice>[], multiple: boolean): string[] | undefined {
  if (!multiple) return options.find(option => option.label === answer) ? [options.find(option => option.label === answer)!.id] : undefined;
  const solutions: string[][] = [];
  const visit = (remaining: string, selected: string[]) => {
    if (solutions.length > 1) return;
    if (!remaining && selected.length) { solutions.push(selected); return; }
    for (const option of options) {
      if (selected.includes(option.id)) continue;
      if (remaining === option.label) visit("", [...selected, option.id]);
      else if (remaining.startsWith(option.label + ", ")) visit(remaining.slice(option.label.length + 2), [...selected, option.id]);
    }
  };
  visit(answer, []);
  return solutions.length === 1 ? solutions[0] : undefined;
}

/** A permission tap, missing answer or unrecognized label never invents a native answer. */
export function cursorQuestionResult(raw: unknown, request: ApprovalRequest, decision: ApprovalDecision) {
  const cancelled = { outcome: { outcome: "cancelled" as const } };
  if (decision.decision !== "allow" || decision.requestId !== request.requestId
    || decision.sessionId !== request.sessionId) return cancelled;
  const input = CursorQuestions.parse(raw);
  const supplied = questionAnswers(request.questions, decision.note);
  if (!supplied) return cancelled;
  const answers = input.questions.map(question => ({ questionId: question.id,
    selectedOptionIds: selectedChoices(supplied[question.prompt] ?? "", question.options, question.allowMultiple === true) }));
  if (answers.some(answer => !answer.selectedOptionIds?.length)) return cancelled;
  return { outcome: { outcome: "answered" as const, answers } };
}
