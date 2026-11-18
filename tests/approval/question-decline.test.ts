import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Payload } from "../../packages/protocol/schema";
import { FakeRelayClient, waitUntil, cfg } from "../support/approval/approval-lifecycle-fixtures";

const DECLINED = "declined (the person chose not to answer)";

function sentOf<T extends Payload["type"]>(fake: FakeRelayClient, type: T) {
  return fake.sent.map((item) => item.payload).filter((payload): payload is Extract<Payload, { type: T }> =>
    payload.type === type);
}

function pairedMachine(): void {
  writeFileSync(join(process.env.GRANTTAP_CONFIG_DIR!, "machine.json"), JSON.stringify(cfg));
}

test("an open question is declinable and a decline ends it without handing the phone's text to the agent", async () => {
  const { askOpenQuestion } = await import("../../apps/mcp/src/http/create-server");
  const fake = new FakeRelayClient();
  const answer = askOpenQuestion(fake as never, "Which branch should I use?", 1_000);
  await waitUntil(() => sentOf(fake, "agent.event").length === 1);
  const question = sentOf(fake, "agent.event")[0]!;
  assert.equal(question.questionDecline, "decline-v1");

  assert.equal(await fake.emit({ type: "user.message", messageId: "decline-1", requestId: question.requestId,
    text: "Words the phone happened to send", questionDecline: "decline-v1", createdAt: Date.now() }), true);
  assert.equal(await answer, DECLINED);

  const terminal = sentOf(fake, "approval.resolved")[0];
  assert.equal(terminal?.status, "applied");
  assert.equal(terminal?.note, "Open question declined");
  assert.equal(terminal?.decision, undefined);
  const receipt = sentOf(fake, "delivery.receipt")[0];
  assert.equal(receipt?.messageId, "decline-1");
  assert.equal(receipt?.status, "accepted");
});

test("a declined yes/no question tells the agent at once, as neither yes nor no", async () => {
  pairedMachine();
  const { askDeclinableYesNo, yesNoText } = await import("../../apps/mcp/src/mcp-tools/connect/relay");
  const fake = new FakeRelayClient();
  const outcome = askDeclinableYesNo(fake as never, "Ship the release?", 2_000);
  await waitUntil(() => sentOf(fake, "approval.request").length === 1);
  const request = sentOf(fake, "approval.request")[0]!;
  assert.equal(request.tool, "ask_yes_no");
  assert.equal(request.questionDecline, "decline-v1");

  const decline = { type: "user.message" as const, messageId: "decline-2", requestId: request.requestId,
    text: "Not answering", questionDecline: "decline-v1" as const, createdAt: Date.now() };
  assert.equal(await fake.emit({ ...decline, requestId: "another-question" }), false);
  assert.equal(await fake.emit({ ...decline, sessionId: "another-chat" }), false);
  assert.equal(await fake.emit({ ...decline, questionDecline: undefined }), false,
    "typed words are not a yes/no answer and do not decline it");
  assert.equal(await fake.emit(decline), true);

  const result = await outcome;
  assert.deepEqual(result, { status: "declined", decision: null });
  assert.equal(yesNoText(result), DECLINED);
  const terminal = sentOf(fake, "approval.resolved").find((item) => item.requestId === request.requestId);
  assert.equal(terminal?.status, "cancelled");
  assert.equal(terminal?.note, "The person declined to answer on the phone.");
  assert.equal(sentOf(fake, "delivery.receipt")[0]?.messageId, "decline-2");
  assert.equal(sentOf(fake, "approval.decision").length, 0, "a decline never mirrors an approval decision");
  assert.equal(await fake.emit(decline), false, "the question is over once declined");
});

test("an answer that arrives before a decline stands", async () => {
  pairedMachine();
  const { askDeclinableYesNo } = await import("../../apps/mcp/src/mcp-tools/connect/relay");
  const fake = new FakeRelayClient();
  const outcome = askDeclinableYesNo(fake as never, "Run the suite?", 2_000);
  await waitUntil(() => sentOf(fake, "approval.request").length === 1);
  const request = sentOf(fake, "approval.request")[0]!;
  assert.equal(await fake.emit({ type: "approval.decision", requestId: request.requestId, decision: "allow",
    decidedBy: "phone", decidedAt: Date.now() }), true);
  assert.deepEqual(await outcome, { status: "answered", decision: "yes" });
  assert.equal(await fake.emit({ type: "user.message", messageId: "late-decline", requestId: request.requestId,
    text: "Not answering", questionDecline: "decline-v1", createdAt: Date.now() }), false);
});

test("a consent question that is not declinable never offers a decline", async () => {
  pairedMachine();
  const { askYesNoOutcome } = await import("../../apps/mcp/src/mcp-tools/connect/relay");
  const fake = new FakeRelayClient();
  const outcome = askYesNoOutcome(fake as never, "Remove the old phones?", 50);
  await waitUntil(() => sentOf(fake, "approval.request").length === 1);
  assert.equal(sentOf(fake, "approval.request")[0]!.questionDecline, undefined);
  assert.equal(await fake.emit({ type: "user.message", messageId: "ignored", text: "No answer",
    requestId: sentOf(fake, "approval.request")[0]!.requestId, questionDecline: "decline-v1",
    createdAt: Date.now() }), false);
  assert.deepEqual(await outcome, { status: "timed_out", decision: null });
});
