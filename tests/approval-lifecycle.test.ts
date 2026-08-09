import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type {
  PeerConfig,
  SendOptions,
} from "../packages/core/relay-client";
import type {
  Payload,
  Role,
} from "../packages/protocol/schema";

type Listener = (payload: Payload) => boolean | void | Promise<boolean | void>;

class FakeRelayClient {
  readonly sent: Array<{
    payload: Payload;
    to: Role | "all";
    options: SendOptions;
    sessionId?: string;
  }> = [];
  private readonly listeners = new Set<Listener>();

  async send(
    payload: Payload,
    to: Role | "all" = "phone",
    options: SendOptions = {},
  ): Promise<void> {
    this.sent.push({ payload, to, options });
  }

  async sendSession(
    payload: Payload,
    sessionId: string,
    to: Role | "all" = "phone",
    options: SendOptions = {},
  ): Promise<void> {
    this.sent.push({ payload, to, options, sessionId });
  }

  setSessionKey(): void {}

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitFor<T extends Payload>(
    predicate: (payload: Payload) => payload is T,
    timeoutMs: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error("waitFor timeout"));
      }, timeoutMs);
      const off = this.onMessage((payload) => {
        if (!predicate(payload)) return false;
        clearTimeout(timer);
        off();
        resolve(payload);
        return true;
      });
    });
  }

  async emit(payload: Payload): Promise<boolean> {
    const results = await Promise.all(
      [...this.listeners].map(async (listener) => (await listener(payload)) === true),
    );
    return results.some(Boolean);
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true, "condition was not reached before timeout");
}

const previousConfigDir = process.env.GRANTTAP_CONFIG_DIR;
const testConfigDir = mkdtempSync(join(tmpdir(), "granttap-mcp-approval-"));
process.env.GRANTTAP_CONFIG_DIR = testConfigDir;

after(() => {
  if (previousConfigDir == null) delete process.env.GRANTTAP_CONFIG_DIR;
  else process.env.GRANTTAP_CONFIG_DIR = previousConfigDir;
  rmSync(testConfigDir, { recursive: true, force: true });
});

const cfg: PeerConfig = {
  relayUrl: "ws://127.0.0.1:1",
  room: "approval-test-room",
  role: "machine",
  deviceName: "test-machine",
  senderId: "test-machine-1",
  myPublicKey: "unused",
  mySecretKey: "unused",
  peerPublicKey: "unused",
};

test("scoped approval becomes durable before ACK and emits deterministic terminal", async () => {
  const { requestApproval } = await import("../apps/bridge/src/approval");
  const { approvalsStatus } = await import("../apps/bridge/src/approval-state");
  const fake = new FakeRelayClient();
  const request = {
    type: "approval.request" as const,
    requestId: "mcp-scoped-request",
    agent: "granttap",
    kind: "permission" as const,
    tool: "ask_yes_no",
    title: "Continue?",
    sessionId: "task-a",
    risk: "low" as const,
    createdAt: Date.now(),
  };

  const decisionP = requestApproval(cfg, request, {
    client: fake as never,
    timeoutMs: 1_000,
  });
  await waitUntil(() => fake.sent.some((item) => item.payload.type === "approval.request"));
  assert.deepEqual(
    approvalsStatus().pending.map((item) => item.requestId),
    [request.requestId],
  );
  assert.equal(approvalsStatus().complete, false);

  assert.equal(await fake.emit({
    type: "approval.decision",
    requestId: request.requestId,
    decision: "allow",
    decidedBy: "watch",
    decidedAt: Date.now(),
  }), false, "missing scope must not ACK");
  assert.equal(await fake.emit({
    type: "approval.decision",
    requestId: request.requestId,
    decision: "allow",
    sessionId: "task-b",
    decidedBy: "phone-notification",
    decidedAt: Date.now(),
  }), false, "foreign scope must not ACK");
  assert.equal(approvalsStatus().pending.length, 1);

  assert.equal(await fake.emit({
    type: "approval.decision",
    requestId: request.requestId,
    decision: "allow",
    sessionId: request.sessionId,
    decidedBy: "watch",
    decidedAt: Date.now(),
  }), true);
  const decision = await decisionP;
  assert.equal(decision.decision, "allow");
  assert.equal(decision.sessionId, request.sessionId);
  assert.deepEqual(approvalsStatus().pending, []);
  assert.equal(
    approvalsStatus().covered?.some((scope) =>
      scope.requestId === request.requestId && scope.sessionId === request.sessionId),
    true,
  );

  const terminal = fake.sent.find((item) => item.payload.type === "approval.resolved");
  assert.equal(terminal?.payload.type, "approval.resolved");
  if (terminal?.payload.type === "approval.resolved") {
    assert.equal(terminal.payload.requestId, request.requestId);
    assert.equal(terminal.payload.status, "applied");
    assert.equal(terminal.payload.sessionId, request.sessionId);
  }
  assert.match(
    terminal?.options.deliveryId ?? "",
    /^approval-resolved-[a-f0-9]{32}$/,
  );
});

test("approval waiter observes a decision durably accepted by the desktop monitor", async () => {
  const { requestApproval } = await import("../apps/bridge/src/approval");
  const { acceptApprovalDecision } = await import("../apps/bridge/src/approval-state");
  const fake = new FakeRelayClient();
  const request = {
    type: "approval.request" as const,
    requestId: "mcp-monitor-won-race",
    agent: "granttap",
    kind: "permission" as const,
    tool: "ask_yes_no",
    title: "Continue after monitor accepted?",
    risk: "low" as const,
    createdAt: Date.now(),
  };
  const decisionP = requestApproval(cfg, request, {
    client: fake as never,
    timeoutMs: 1_000,
  });
  await waitUntil(() => fake.sent.some((item) => item.payload.type === "approval.request"));
  const accepted = acceptApprovalDecision({
    type: "approval.decision",
    requestId: request.requestId,
    decision: "allow",
    decidedBy: "phone",
    decidedAt: Date.now(),
  });
  assert.equal(accepted.matched, true);
  assert.equal((await decisionP).decision, "allow");
});

test("timeout replays a concurrently durable decision instead of publishing expiration", async () => {
  const { requestApproval } = await import("../apps/bridge/src/approval");
  const { acceptApprovalDecision } = await import("../apps/bridge/src/approval-state");
  const fake = new FakeRelayClient();
  const request = {
    type: "approval.request" as const,
    requestId: "timeout-must-replay-decision-winner",
    agent: "granttap",
    kind: "permission" as const,
    tool: "ask_yes_no",
    title: "Do not expire the winner",
    sessionId: "timeout-race-task",
    risk: "low" as const,
    createdAt: Date.now(),
  };
  const decisionP = requestApproval(cfg, request, {
    client: fake as never,
    timeoutMs: 20,
  });
  await waitUntil(() => fake.sent.some((item) => item.payload.type === "approval.request"));
  assert.equal(acceptApprovalDecision({
    type: "approval.decision",
    requestId: request.requestId,
    decision: "allow",
    sessionId: request.sessionId,
    decidedBy: "desktop-monitor",
    decidedAt: Date.now(),
  }).newlyResolved, true);

  assert.equal((await decisionP).decision, "allow");
  const terminals = fake.sent
    .map((item) => item.payload)
    .filter((payload) => payload.type === "approval.resolved");
  assert.equal(terminals.some((payload) => payload.status === "expired"), false);
  assert.equal(
    terminals.some((payload) => payload.status === "applied" && payload.decision === "allow"),
    true,
  );
});

test("conflicting same-scope request-id reuse fails closed without sending the dangerous request", async () => {
  const { requestApproval } = await import("../apps/bridge/src/approval");
  const {
    acceptApprovalDecision,
    registerPendingApproval,
    resolvedApprovalDecision,
  } = await import("../apps/bridge/src/approval-state");
  const fake = new FakeRelayClient();
  const requestId = "same-scope-dangerous-command-reuse";
  const sessionId = "same-scope-dangerous-command-task";
  const first = {
    type: "approval.request" as const,
    requestId,
    agent: "cursor",
    kind: "permission" as const,
    tool: "Shell",
    title: "Allow safe command?",
    command: "git status",
    sessionId,
    risk: "low" as const,
    createdAt: Date.now(),
  };
  registerPendingApproval(first);
  assert.equal(acceptApprovalDecision({
    type: "approval.decision",
    requestId,
    decision: "allow",
    sessionId,
    decidedBy: "phone",
    decidedAt: Date.now(),
  }).newlyResolved, true);
  const duplicate = registerPendingApproval({ ...first, createdAt: first.createdAt + 10 });
  assert.equal(duplicate.matched, true);
  if (duplicate.matched) {
    assert.equal(duplicate.newlyRegistered, false);
    assert.equal(
      resolvedApprovalDecision(requestId, sessionId, duplicate.handle)?.decision,
      "allow",
      "an exact duplicate joins and replays the existing winner",
    );
  }

  const result = await requestApproval(cfg, {
    ...first,
    title: "Allow destructive command?",
    command: "rm -rf ./important-data",
    risk: "high",
    createdAt: first.createdAt + 1,
  }, {
    client: fake as never,
    timeoutMs: 20,
  });

  assert.equal(result.decision, "deny");
  assert.match(result.note ?? "", /request id|conflict|reuse/i);
  assert.equal(
    fake.sent.some((item) => item.payload.type === "approval.request"),
    false,
    "a conflicting request must fail before relay/Web publication",
  );
});

test("Web approval is scoped, durable, first-decision-wins, and cleaned up", async () => {
  const { requestApproval } = await import("../apps/bridge/src/approval");
  const { resolvedApprovalDecision } = await import("../apps/bridge/src/approval-state");
  const fake = new FakeRelayClient();
  const cloudCfg: PeerConfig = { ...cfg, pushAuth: "cd".repeat(32) };
  const methods: string[] = [];
  let published = false;
  const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const method = init?.method ?? "GET";
    methods.push(method);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${cloudCfg.pushAuth}`);
    if (method === "PUT") {
      published = true;
      return Response.json({
        ok: true,
        pageUrl: "http://127.0.0.1:1/a/room/private-token",
      });
    }
    if (method === "DELETE") return Response.json({ ok: true });
    return Response.json({
      ok: true,
      approvals: published
        ? [{ requestId: "web-wins-request", status: "allow", decidedBy: "web" }]
        : [],
    });
  }) as typeof fetch;
  const request = {
    type: "approval.request" as const,
    requestId: "web-wins-request",
    agent: "cursor",
    kind: "permission" as const,
    tool: "Shell",
    title: "Allow Web decision?",
    command: "git status",
    sessionId: "web-chat-a",
    risk: "low" as const,
    createdAt: Date.now(),
  };

  const decision = await requestApproval(cloudCfg, request, {
    client: fake as never,
    fetchImpl,
    cloudPollMs: 1,
    timeoutMs: 1_000,
  });
  assert.equal(decision.decision, "allow");
  assert.equal(decision.decidedBy, "web");
  assert.equal(decision.sessionId, request.sessionId);
  assert.equal(
    resolvedApprovalDecision(request.requestId, request.sessionId)?.decision,
    "allow",
  );
  assert.equal(methods.includes("PUT"), true);
  assert.equal(methods.includes("GET"), true);
  assert.equal(methods.at(-1), "DELETE");

  assert.equal(await fake.emit({
    type: "approval.decision",
    requestId: request.requestId,
    decision: "deny",
    sessionId: request.sessionId,
    decidedBy: "phone-late",
    decidedAt: Date.now(),
  }), false, "a late phone response must not reopen or replace the Web decision");
  assert.equal(
    resolvedApprovalDecision(request.requestId, request.sessionId)?.decision,
    "allow",
  );
});

test("phone decision aborts a hanging Web publish without delaying completion", async () => {
  const { requestApproval } = await import("../apps/bridge/src/approval");
  const fake = new FakeRelayClient();
  const cloudCfg: PeerConfig = { ...cfg, pushAuth: "ef".repeat(32) };
  let publishAborted = false;
  let deleteCalled = false;
  const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "DELETE") {
      deleteCalled = true;
      return Response.json({ ok: true });
    }
    if (method === "GET") return Response.json({ ok: true, approvals: [] });
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => {
        publishAborted = true;
        reject(new DOMException("aborted", "AbortError"));
      };
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  }) as typeof fetch;
  const request = {
    type: "approval.request" as const,
    requestId: "phone-aborts-web-request",
    agent: "claude",
    kind: "permission" as const,
    tool: "Bash",
    title: "Allow phone decision?",
    risk: "medium" as const,
    createdAt: Date.now(),
  };

  const startedAt = Date.now();
  const decisionP = requestApproval(cloudCfg, request, {
    client: fake as never,
    fetchImpl,
    cloudPollMs: 1,
    timeoutMs: 1_000,
  });
  await waitUntil(() => fake.sent.some((item) => item.payload.type === "approval.request"));
  assert.equal(await fake.emit({
    type: "approval.decision",
    requestId: request.requestId,
    decision: "allow",
    decidedBy: "phone",
    decidedAt: Date.now(),
  }), true);
  const decision = await decisionP;
  assert.equal(decision.decision, "allow");
  assert.equal(decision.decidedBy, "phone");
  assert.equal(publishAborted, true);
  assert.equal(deleteCalled, true);
  assert.ok(Date.now() - startedAt < 250);
});

test("open question sends only user.message reply lifecycle and terminal cleanup", async () => {
  const { askOpenQuestion } = await import("../apps/mcp/src/create-server");
  const fake = new FakeRelayClient();
  const answerP = askOpenQuestion(fake as never, "What should I do?", 1_000);
  await waitUntil(() => fake.sent.some((item) => item.payload.type === "agent.event"));
  const question = fake.sent.find((item) => item.payload.type === "agent.event");
  assert.equal(question?.payload.type, "agent.event");
  const requestId = question?.payload.type === "agent.event"
    ? question.payload.requestId
    : undefined;
  assert.ok(requestId);

  assert.equal(await fake.emit({
    type: "approval.decision",
    requestId: requestId!,
    decision: "allow",
    decidedBy: "phone",
    decidedAt: Date.now(),
  }), false, "legacy extra approval.decision must not answer an open question");
  assert.equal(await fake.emit({
    type: "user.message",
    messageId: "open-answer-1",
    requestId: requestId!,
    text: "yes",
    createdAt: Date.now(),
  }), true);
  assert.equal(await answerP, "yes");

  const terminal = fake.sent.find((item) => item.payload.type === "approval.resolved");
  assert.equal(terminal?.payload.type, "approval.resolved");
  if (terminal?.payload.type === "approval.resolved") {
    assert.equal(terminal.payload.requestId, requestId);
    assert.equal(terminal.payload.status, "applied");
    assert.equal(terminal.payload.decision, undefined);
  }
  const receipt = fake.sent.find((item) => item.payload.type === "delivery.receipt");
  assert.equal(receipt?.payload.type, "delivery.receipt");
  if (receipt?.payload.type === "delivery.receipt") {
    assert.equal(receipt.payload.messageId, "open-answer-1");
    assert.equal(receipt.payload.status, "accepted");
  }
  assert.ok(
    fake.sent.indexOf(terminal!) < fake.sent.indexOf(receipt!),
    "terminal and delivery receipt must be sent before the listener ACKs",
  );
  assert.equal(
    fake.sent.filter((item) => item.payload.type === "approval.decision").length,
    0,
    "machine must not mirror a decision for an open question",
  );
});

test("open question timeout emits an expired terminal", async () => {
  const { askOpenQuestion } = await import("../apps/mcp/src/create-server");
  const fake = new FakeRelayClient();
  assert.equal(
    await askOpenQuestion(fake as never, "Still there?", 10),
    "no-answer (timeout)",
  );
  const terminal = fake.sent.find((item) => item.payload.type === "approval.resolved");
  assert.equal(terminal?.payload.type, "approval.resolved");
  if (terminal?.payload.type === "approval.resolved") {
    assert.equal(terminal.payload.status, "expired");
  }
});

test("scoped receipts carry inner scope and response events carry originMessageId", async () => {
  const {
    agentEventForUserMessage,
    sendDeliveryReceipt,
  } = await import("../apps/bridge/src/monitor");
  const fake = new FakeRelayClient();
  await sendDeliveryReceipt(
    fake as never,
    "scoped-message-1",
    "accepted",
    undefined,
    "task-receipt-a",
  );
  const receipt = fake.sent.find((item) => item.payload.type === "delivery.receipt");
  assert.equal(receipt?.sessionId, "task-receipt-a");
  assert.equal(receipt?.payload.type, "delivery.receipt");
  if (receipt?.payload.type === "delivery.receipt") {
    assert.equal(receipt.payload.sessionId, "task-receipt-a");
  }

  const event = agentEventForUserMessage({
    type: "user.message",
    messageId: "origin-message-1",
    sessionId: "task-receipt-a",
    text: "run tests",
    createdAt: Date.now(),
  }, "Working…", "task-receipt-a", "status");
  assert.equal(event.originMessageId, "origin-message-1");
  assert.equal(event.sessionId, "task-receipt-a");
  assert.equal(event.kind, "status");
});
