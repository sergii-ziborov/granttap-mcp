import { RelayClient } from "../../../../packages/core/relay-client";
import { randomId } from "../../../../packages/core/crypto";
import type { Payload } from "../../../../packages/protocol/schema";
import { isUnanswered, requestApproval } from "../../../bridge/src/approval";
import { sendApprovalResolved, terminalApproval } from "../../../bridge/src/approval-state";
import { loadConfig, machineConfigPath } from "../../../bridge/src/config";
import { startSessionMonitor, type SessionMonitor } from "../../../bridge/src/monitor";

const ASK_TIMEOUT_MS = Number(process.env.GRANTTAP_ASK_TIMEOUT_MS ?? process.env.NODVOX_ASK_TIMEOUT_MS ?? 180_000);
let client: RelayClient | null = null;
let monitor: SessionMonitor | null = null;

export async function relay(): Promise<RelayClient | null> {
  try {
    if (!client) {
      client = new RelayClient(loadConfig(machineConfigPath()), { autoReconnect: true });
      monitor = startSessionMonitor(client);
    }
    await client.connect();
    await monitor?.publish().catch(() => {});
    return client;
  } catch {
    return null;
  }
}

export function resetRelay(): void {
  monitor?.close();
  monitor = null;
  client?.close();
  client = null;
}

export async function askYesNo(client: RelayClient, question: string, timeoutMs = ASK_TIMEOUT_MS): Promise<string> {
  const requestId = randomId(6);
  const decision = await requestApproval(loadConfig(machineConfigPath()), {
    type: "approval.request", requestId, agent: "granttap", kind: "permission",
    tool: "ask_yes_no", title: question, risk: "low", createdAt: Date.now(),
  }, { client, timeoutMs });
  if (isUnanswered(decision)) return "no-answer (timeout)";
  return decision.decision === "allow" ? "yes" : "no";
}

export async function askOpenQuestion(client: RelayClient, question: string, timeoutMs = ASK_TIMEOUT_MS): Promise<string> {
  const requestId = randomId(6);
  const reply = await waitForReply(client, requestId, timeoutMs, question);
  if (!reply) {
    await sendApprovalResolved(client, terminalApproval(requestId, "expired", {
      note: "No response before timeout",
    })).catch(() => {});
  }
  return reply ? reply.text : "no-answer (timeout)";
}

async function waitForReply(client: RelayClient, requestId: string, timeoutMs: number, question: string): Promise<Reply | null> {
  let cancelReplyWait = () => {};
  const replyP = listenForReply(client, requestId, timeoutMs, (cancel) => { cancelReplyWait = cancel; });
  try {
    await client.send({ type: "agent.event", text: question, requestId, kind: "question", createdAt: Date.now() }, "phone", { ttlMs: timeoutMs, wake: true });
  } catch (error) {
    cancelReplyWait();
    throw error;
  }
  return replyP;
}

type Reply = Extract<Payload, { type: "user.message" }>;

function listenForReply(
  client: RelayClient,
  requestId: string,
  timeoutMs: number,
  setCancel: (cancel: () => void) => void,
): Promise<Reply | null> {
  return new Promise((resolve) => {
    let settled = false;
    let handling = false;
    let appliedTerminal: ReturnType<typeof terminalApproval> | undefined;
    let off = () => {};
    const finish = (reply: Reply | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      resolve(reply);
    };
    setCancel(() => finish(null));
    const timer = setTimeout(() => finish(null), timeoutMs);
    off = client.onMessage(async (payload: Payload) => {
      if (payload.type !== "user.message" || payload.requestId !== requestId || payload.sessionId?.trim() || handling) return false;
      handling = true;
      appliedTerminal ??= terminalApproval(requestId, "applied", { note: "Open question answered" });
      try {
        await sendApprovalResolved(client, appliedTerminal);
        if (payload.messageId) await sendReceipt(client, payload.messageId);
        finish(payload);
        return true;
      } catch {
        handling = false;
        return false;
      }
    });
  });
}

function sendReceipt(client: RelayClient, messageId: string): Promise<void> {
  return client.send({ type: "delivery.receipt", messageId, status: "accepted", receivedAt: Date.now() }, "phone", { ttlMs: 24 * 60 * 60_000 });
}
