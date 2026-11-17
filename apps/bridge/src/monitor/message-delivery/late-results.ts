/**
 * Sending a phone delivery's outcome to the phone, the same way whichever monitor holds the run: the
 * one that started it, or a newer one that took it over after a runtime update (`reply/survival`).
 * What is needed is kept as plain data, so it can wait in the run's folder.
 */
import type { RelayClient } from "../../../../../packages/core/relay-client";
import type { SessionInfo, UserMessage } from "../../../../../packages/protocol/schema";
import { rejectCompletedDelivery } from "../../delivery";
import { sendSessionPayload } from "../../host/session-keys";
import { noteDeliveredRun } from "../../mesh/delivery/run-digest";
import type { ReplyResult } from "../../reply";
import { registerRunContinuation, type SurvivorHandle } from "../../reply/survival";
import { localTaskOrigins, type TaskOriginScope } from "../../task-origins";
import { agentEventForUserMessage, sendDeliveryReceipt } from "../handlers/receipts";

/** What of the person's message an answer refers to. */
type Sent = Pick<UserMessage, "messageId" | "requestId" | "text">;
export type ChatReply = { message: Sent; peerPublicKey?: string; target: SessionInfo; startedAt: number };
export type NewTask = { message: Sent; peerPublicKey?: string; displayName: string; origin?: TaskOriginScope };

export function sentMessage(message: UserMessage): Sent {
  return { messageId: message.messageId, requestId: message.requestId, text: message.text };
}

function sayer(client: RelayClient, message: Sent, peerPublicKey?: string) {
  return (text: string, sessionId?: string, wake = false) => {
    const payload = agentEventForUserMessage(message as UserMessage, text, sessionId, "response");
    const options = { ttlMs: 15 * 60_000, wake: wake || undefined, peerPublicKey };
    return (sessionId
      ? sendSessionPayload(client, payload, sessionId, "phone", options)
      : client.send(payload, "phone", options)).catch(() => {});
  };
}

/** A message to an existing chat: its run's journal and progress, then the answer or why it stopped. */
export async function settleChatReply(client: RelayClient, data: ChatReply, result: ReplyResult, late: boolean): Promise<void> {
  const { message, peerPublicKey, target } = data;
  if (result.ok && (result.delivery === 'native' || result.delivery === 'handed-over')) return;
  const say = sayer(client, message, peerPublicKey);
  // The run's turns are in the transcript, but a session holding this chat
  // open never sees them; the journal is how it finds out on its next prompt,
  // and the Task carries the same digest as progress.
  const noted = noteDeliveredRun({ session: target, prompt: message.text, result, startedAt: data.startedAt, endedAt: Date.now() });
  if (noted?.event) {
    await sendSessionPayload(client, noted.event, noted.event.taskId, "phone", { ttlMs: 24 * 60 * 60_000 })
      .catch(() => {});
  }
  if (result.ok) { await say(result.text, result.sessionId ?? target.sessionId, true); return; }
  if (result.delivery !== 'native') {
    if (late && message.messageId) rejectCompletedDelivery(message.messageId, result.error);
    if (message.messageId) await sendDeliveryReceipt(client, message.messageId, 'rejected',
      result.error, target.sessionId, peerPublicKey);
  }
  await say(late || result.delivery === 'native' ? `The run stopped: ${result.error}`
    : `Could not deliver the message: ${result.error}`, target.sessionId, true);
}

/** A message that starts a new task: the task's origin, then its first answer or why it stopped. */
export async function settleNewTask(client: RelayClient, data: NewTask, result: ReplyResult, late: boolean): Promise<void> {
  const { message, peerPublicKey, displayName, origin } = data;
  // The monitor that takes the run over completes the task's origin and sends its answer.
  if (result.ok && result.delivery === 'handed-over') return;
  if (origin) localTaskOrigins().complete(origin, { ok: result.ok || result.delivery === 'native',
    sessionId: result.ok ? result.sessionId : undefined });
  if (!result.ok && message.messageId && result.delivery !== 'native') {
    if (late) rejectCompletedDelivery(message.messageId, result.error);
    await sendDeliveryReceipt(client, message.messageId, 'rejected', result.error, undefined, peerPublicKey);
  }
  const say = sayer(client, message, peerPublicKey);
  await (result.ok ? say(result.text, result.sessionId, true)
    : say(late || result.delivery === 'native' ? `The ${displayName} task stopped: ${result.error}`
      : `Could not create a ${displayName} task: ${result.error}`, undefined, true));
}

export function chatReplyHandle(data: ChatReply): SurvivorHandle {
  return { continuation: { kind: "chat-reply", data }, late: false };
}

export function newTaskHandle(data: NewTask): SurvivorHandle {
  return { continuation: { kind: "new-task", data }, late: false };
}

/** A monitor that took runs over sends their answers through its own relay link. */
export function registerLateResults(client: RelayClient): void {
  registerRunContinuation("chat-reply", (data, result) => settleChatReply(client, data as ChatReply, result, true));
  registerRunContinuation("new-task", (data, result) => settleNewTask(client, data as NewTask, result, true));
}
