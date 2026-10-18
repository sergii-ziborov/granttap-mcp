import assert from "node:assert/strict";
import test from "node:test";
import { cursorQuestionRequest, cursorQuestionResult } from "../questions";

const source = { toolCallId: "native-call", title: "Choose next step", questions: [
  { id: "next", prompt: "What should happen next?", options: [
    { id: "test", label: "Run tests" }, { id: "review", label: "Review changes" }], allowMultiple: false },
] };
const scope = { sessionId: "task", cwd: "/fixture" };

test("Cursor questions retain the native option IDs behind a real GrantTap answer form", () => {
  const request = cursorQuestionRequest(source, scope, "turn");
  assert.equal(request.kind, "question"); assert.equal(request.agent, "cursor");
  assert.equal(request.sessionId, "task"); assert.equal(request.questions?.[0]?.question, source.questions[0]!.prompt);
  const base = { type: "approval.decision" as const, requestId: request.requestId,
    sessionId: "task", decision: "allow" as const, decidedAt: 1 };
  assert.deepEqual(cursorQuestionResult(source, request, { ...base,
    note: JSON.stringify({ "What should happen next?": "Run tests" }) }), {
    outcome: { outcome: "answered", answers: [{ questionId: "next", selectedOptionIds: ["test"] }] },
  });
  for (const changed of [{}, { note: "Run tests" }, { note: '{"What should happen next?":"unknown"}' },
    { note: '{"What should happen next?":"Run tests"}', sessionId: "other" }, { decision: "deny" as const }]) {
    assert.deepEqual(cursorQuestionResult(source, request, { ...base, ...changed }), { outcome: { outcome: "cancelled" } });
  }
});

test("Cursor multi-select preserves comma-bearing labels and refuses ambiguous or incomplete answers", () => {
  const input = { ...source, questions: [{ id: "many", prompt: "Select actions", allowMultiple: true,
    options: [{ id: "a", label: "Build, test" }, { id: "b", label: "Review" }] }] };
  const request = cursorQuestionRequest(input, scope, "turn");
  const decision = { type: "approval.decision" as const, requestId: request.requestId, sessionId: "task",
    decision: "allow" as const, decidedAt: 1, note: JSON.stringify({ "Select actions": "Build, test, Review" }) };
  assert.deepEqual(cursorQuestionResult(input, request, decision), { outcome: { outcome: "answered",
    answers: [{ questionId: "many", selectedOptionIds: ["a", "b"] }] } });
  assert.throws(() => cursorQuestionRequest({ ...source, questions: [] }, scope, "turn"));
  assert.throws(() => cursorQuestionRequest({ ...source, questions: [source.questions[0], source.questions[0]] }, scope, "turn"));
});
