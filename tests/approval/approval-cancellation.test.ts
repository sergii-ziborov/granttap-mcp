import assert from "node:assert/strict";
import test from "node:test";
import { requestApproval } from "../../apps/bridge/src/approvals";
import { approvalsStatus, acceptApprovalDecision, registerPendingApproval } from "../../apps/bridge/src/approvals/state";
import { FakeRelayClient, waitUntil, cfg } from "../support/approval/approval-lifecycle-fixtures";

test("stopping an exact provider waiter durably cancels its form and preserves unrelated forms", async () => {
  const client = new FakeRelayClient(), controller = new AbortController();
  const request = { type: "approval.request" as const, requestId: "cursor-process-stopped", agent: "cursor",
    kind: "permission" as const, tool: "Shell", title: "Fixture", risk: "low" as const,
    sessionId: "stopped-task", createdAt: Date.now() };
  registerPendingApproval({ ...request, requestId: "other-live-form", sessionId: "other-task" });
  const pending = requestApproval(cfg, request, { client: client as never, signal: controller.signal, timeoutMs: 60_000 });
  await waitUntil(() => client.sent.some(row => row.payload.type === "approval.request"));
  const before = Date.now(); controller.abort();
  const result = await pending;
  assert.equal(result.decision, "deny"); assert.equal(result.decidedBy, "cancelled");
  assert(Date.now() - before < 500, "Task Stop must not wait for the phone timeout");
  assert.deepEqual(approvalsStatus().pending.map(row => row.requestId), ["other-live-form"]);
  assert(client.sent.some(row => row.payload.type === "approval.resolved"
    && row.payload.requestId === request.requestId && row.payload.status === "cancelled"));
  const late = acceptApprovalDecision({ type: "approval.decision", requestId: request.requestId,
    sessionId: request.sessionId, decision: "allow", decidedAt: Date.now() });
  assert.equal(late.outcome?.kind, "terminal");
});

test("a stopped-before-delivery form is never sent to the controller", async () => {
  const client = new FakeRelayClient(), signal = AbortSignal.abort();
  const result = await requestApproval(cfg, { type: "approval.request", requestId: "already-stopped", agent: "cursor",
    kind: "permission", tool: "Shell", title: "Fixture", sessionId: "stopped-before-send", risk: "low", createdAt: Date.now() },
  { client: client as never, signal });
  assert.equal(result.decision, "deny");
  assert(!client.sent.some(row => row.payload.type === "approval.request"));
});
