import type { AgentEvent, UserAttachment, UserMessage } from "../../../../../packages/protocol/schema";
import { MAX_USER_ATTACHMENTS } from "../../../../../packages/protocol/schema";
import type { RelayClient } from "../../../../../packages/core/relay-client";
import { pruneAttachments, takeAttachment } from "../../delivery/attachment-store";
import { sendSessionPayload } from "../../host/session-keys";

export const DELIVERY_TIMEOUT_MS = 10 * 60_000;

export async function sendDeliveryReceipt(
  client: RelayClient,
  messageId: string,
  status: "accepted" | "rejected",
  error?: string,
  sessionId?: string,
): Promise<void> {
  const payload = {
    type: "delivery.receipt" as const,
    messageId,
    sessionId: sessionId?.trim() || undefined,
    status,
    error,
    receivedAt: Date.now(),
  };
  const options = { ttlMs: 24 * 60 * 60_000 };
  await (sessionId
    ? sendSessionPayload(client, payload, sessionId, "phone", options)
    : client.send(payload, "phone", options)).catch(() => {});
}

export function agentEventForUserMessage(
  message: UserMessage,
  text: string,
  sessionId?: string,
  kind: "status" | "response" = "response",
): AgentEvent {
  return {
    type: "agent.event",
    text,
    requestId: message.requestId,
    kind,
    sessionId,
    originMessageId: message.messageId,
    createdAt: Date.now(),
  };
}

const ATTACHMENT_SWEEP_MS = 10 * 60_000;
let attachmentsSweptAt = 0;

/**
 * An attachment no message ever named is dropped once its time is up,
 * whether or not another one arrives: the sweep rides on the publish loop,
 * a few times an hour, instead of waiting for the next upload.
 */
export function sweepAttachments(now = Date.now()): number {
  if (now - attachmentsSweptAt < ATTACHMENT_SWEEP_MS) return 0;
  attachmentsSweptAt = now;
  return pruneAttachments(now);
}

/**
 * The attachments a message carries: the ones inside it, and the ones that
 * came ahead of it by id. One that never came is a rejection the phone reads
 * as "send them again, inline", not a message quietly delivered without its photo.
 */
export function resolveMessageAttachments(
  message: Pick<UserMessage, "attachments" | "attachmentRefs">,
  take: (attachmentId: string) => UserAttachment | undefined = takeAttachment,
): { ok: true; attachments: UserAttachment[] } | { ok: false; missing: string } {
  const attachments = [...(message.attachments ?? [])];
  for (const ref of message.attachmentRefs ?? []) {
    const stored = take(ref.attachmentId);
    if (!stored) return { ok: false, missing: ref.name };
    attachments.push(stored);
  }
  return { ok: true, attachments: attachments.slice(0, MAX_USER_ATTACHMENTS) };
}
