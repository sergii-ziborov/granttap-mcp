import { RelayClient } from "../../../../../packages/core/relay-client";
import { randomId } from "../../../../../packages/core/crypto";
import type { Payload } from "../../../../../packages/protocol/schema";
import { isUnanswered, requestApproval } from "../../../../bridge/src/approvals";
import { sendApprovalResolved, terminalApproval } from "../../../../bridge/src/approvals/state";
import { loadConfig, machineConfigPath } from "../../../../bridge/src/config";
import { startSessionMonitor, type SessionMonitor } from "../../../../bridge/src/monitor";
import { sendSessionPayload } from "../../../../bridge/src/host/session-keys";
import { publishHeldHeartbeat } from "../../../../bridge/src/monitor/support/heartbeat";
import { applyPairingJoin } from "../../../../bridge/src/pairing";
import { installMonitorHelper, reloadMonitorHelper } from "../../../../bridge/src/install";
import { recordPhoneSeen } from "../../../../bridge/src/pairing/presence";
import { completeEnrollment } from "../../connection-center/enrollment";
import { confirmPendingController, controllerPeerGate } from "../../../../bridge/src/pairing/controllers";

const ASK_TIMEOUT_MS = Number(
  process.env.GRANTTAP_ASK_TIMEOUT_MS ?? process.env.NODVOX_ASK_TIMEOUT_MS ?? 180_000,
);
let client: RelayClient | null = null;
let monitor: SessionMonitor | null = null;
let phoneLastSeenAt: number | null = null;

export type TaskInteractionScope = {
  provider: "claude" | "codex" | "cursor" | "grok";
  sessionId: string;
  projectId: string;
  taskId: string;
  computerId: string;
};

export async function relay(): Promise<RelayClient | null> {
  try {
    if (!client) {
      const config = loadConfig(machineConfigPath());
      client = new RelayClient(config, { autoReconnect: true, peerAllowed: controllerPeerGate(config) });
      client.onMessage((payload, peerPublicKey) => {
        if (payload.type === "pairing.join") {
          const result = applyPairingJoin(payload);
          if (result === "adopted") {
            completeEnrollment(payload.phonePublicKey);
            installMonitorHelper();
            reloadMonitorHelper();
            setImmediate(() => {
              resetRelay();
              void relay();
            });
          }
          return true;
        }
        if (payload.type === "hello" && payload.role === "phone") {
          confirmPendingController(client!.room, peerPublicKey);
          completeEnrollment(peerPublicKey);
        }
        phoneLastSeenAt = Date.now();
        recordPhoneSeen(phoneLastSeenAt, peerPublicKey);
        return false;
      });
      monitor = startSessionMonitor(client);
    }
    await client.connect();
    await publishHeldHeartbeat(client).catch(() => {});
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
  phoneLastSeenAt = null;
}

/** Observe this process only; never start a connection for a status request. */
export function connectionRuntimeStatus(room?: string): {
  relayStatus: "online" | "offline" | "unknown";
  phoneLastSeenAt: number | null;
} {
  if (!client || client.room !== room) {
    return { relayStatus: "unknown", phoneLastSeenAt: null };
  }
  return {
    relayStatus: client.isConnected ? "online" : "offline",
    phoneLastSeenAt,
  };
}

/**
 * What came back from the phone, kept apart: a decision the person made, or
 * silence. A timeout is never read as "no", and never as "yes".
 */
export type YesNoOutcome =
  | { status: "answered"; decision: "yes" | "no" }
  | { status: "timed_out"; decision: null };
export type OpenOutcome =
  | { status: "answered"; answer: string }
  | { status: "timed_out"; answer: null };

export const NO_ANSWER = "no-answer (timeout)";

export function yesNoText(outcome: YesNoOutcome): string {
  return outcome.status === "answered" ? outcome.decision : NO_ANSWER;
}

export function openAnswerText(outcome: OpenOutcome): string {
  return outcome.status === "answered" ? outcome.answer : NO_ANSWER;
}

export async function askYesNo(
  client: RelayClient,
  question: string,
  timeoutMs = ASK_TIMEOUT_MS,
  scope?: TaskInteractionScope,
): Promise<string> {
  return yesNoText(await askYesNoOutcome(client, question, timeoutMs, scope));
}

export async function askYesNoOutcome(
  client: RelayClient,
  question: string,
  timeoutMs = ASK_TIMEOUT_MS,
  scope?: TaskInteractionScope,
): Promise<YesNoOutcome> {
  const requestId = randomId(6);
  const decision = await requestApproval(
    loadConfig(machineConfigPath()),
    {
      type: "approval.request",
      requestId,
      agent: scope?.provider ?? "granttap",
      kind: "permission",
      tool: "ask_yes_no",
      title: question,
      sessionId: scope?.sessionId,
      projectId: scope?.projectId,
      taskId: scope?.taskId,
      computerId: scope?.computerId,
      risk: "low",
      createdAt: Date.now(),
    },
    { client, timeoutMs },
  );
  if (isUnanswered(decision)) return { status: "timed_out", decision: null };
  return { status: "answered", decision: decision.decision === "allow" ? "yes" : "no" };
}

export async function askOpenQuestion(
  client: RelayClient,
  question: string,
  timeoutMs = ASK_TIMEOUT_MS,
  scope?: TaskInteractionScope,
): Promise<string> {
  return openAnswerText(await askOpenQuestionOutcome(client, question, timeoutMs, scope));
}

export async function askOpenQuestionOutcome(
  client: RelayClient,
  question: string,
  timeoutMs = ASK_TIMEOUT_MS,
  scope?: TaskInteractionScope,
): Promise<OpenOutcome> {
  const requestId = randomId(6);
  const reply = await waitForReply(client, requestId, timeoutMs, question, scope);
  if (!reply) {
    await sendApprovalResolved(client, terminalApproval(requestId, "expired", {
      note: "No response before timeout",
    })).catch(() => {});
    return { status: "timed_out", answer: null };
  }
  return { status: "answered", answer: reply.text };
}

async function waitForReply(
  client: RelayClient,
  requestId: string,
  timeoutMs: number,
  question: string,
  scope?: TaskInteractionScope,
): Promise<Reply | null> {
  let cancelReplyWait = () => {};
  const replyP = listenForReply(client, requestId, timeoutMs, scope?.sessionId, (cancel) => {
    cancelReplyWait = cancel;
  });
  try {
    const payload = {
      type: "agent.event" as const, text: question, requestId, kind: "question" as const,
      sessionId: scope?.sessionId, agent: scope?.provider, projectId: scope?.projectId,
      taskId: scope?.taskId, computerId: scope?.computerId, createdAt: Date.now(),
    };
    const options = { ttlMs: timeoutMs, wake: true };
    if (scope) await sendSessionPayload(client, payload, scope.sessionId, "phone", options);
    else await client.send(payload, "phone", options);
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
  sessionId: string | undefined,
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
      if (
        payload.type !== "user.message"
        || payload.requestId !== requestId
        || (payload.sessionId?.trim() || undefined) !== sessionId
        || handling
      ) return false;
      handling = true;
      appliedTerminal ??= terminalApproval(requestId, "applied", { note: "Open question answered" });
      try {
        await sendApprovalResolved(client, appliedTerminal);
        if (payload.messageId) {
          await sendReceipt(client, payload.messageId);
        }
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
  return client.send(
    {
      type: "delivery.receipt",
      messageId,
      status: "accepted",
      receivedAt: Date.now(),
    },
    "phone",
    { ttlMs: 24 * 60 * 60_000 },
  );
}
