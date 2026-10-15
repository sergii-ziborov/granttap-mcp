import type { UserMessage } from "../../../../../packages/protocol/schema";
import { ATTACHMENT_MISSING_ERROR } from "../../../../../packages/protocol/schema";
import type { RelayClient } from "../../../../../packages/core/relay-client";
import { takeAttachment } from "../../delivery/attachment-store";
import { loadRuntimeConfig } from "../../config";
import { deliveryRoutingError } from "../../capabilities";
import {
  createClaudeSession,
  createCodexSession,
  createCursorSession,
  createGrokSession,
  deliverToSession,
} from "../../reply";
import { noteDeliveredRun } from "../../mesh/delivery/run-digest";
import { evaluateCreateTask } from "../../mesh/tasks/create-task";
import { sendSessionPayload } from "../../host/session-keys";
import { scanSessions } from "../../sessions";
import { agentEventForUserMessage, sendDeliveryReceipt } from "./receipts";
import { resolveMessageAttachments } from "./receipts";
import { DELIVERY_TIMEOUT_MS } from "./receipts";

async function startNewAgentTask(input: {
  client: RelayClient;
  message: UserMessage;
  say: (text: string, sessionId?: string, wake?: boolean, kind?: "status" | "response") => Promise<unknown>;
  onProcessing?: () => Promise<void>;
}): Promise<"accepted" | "rejected"> {
  const { client, message, say } = input;
  const agent = message.agent ?? "codex";
  const displayName = {
    claude: "Claude Code", codex: "Codex", cursor: "Cursor", grok: "Grok Build",
  }[agent];
  if (!loadRuntimeConfig().providerSettings[agent]) {
    await say(`${displayName} is disabled in GrantTap Settings.`, undefined, true);
    return "rejected";
  }
  const requestedCwd = message.cwd?.trim();
  if (requestedCwd) {
    const admitted = evaluateCreateTask({
      cwd: requestedCwd, agent, model: message.model,
      projectId: message.projectId,
      hostOnline: client.isConnected,
    });
    if (!admitted.ok) {
      await say(admitted.detail, undefined, true);
      return "rejected";
    }
    if ("queued" in admitted && admitted.queued) {
      // The phone's durable outbox retries after reconnect. This monitor has
      // no worker for its separate pinned-task queue, so do not launch here.
      return "rejected";
    }
  }
  const resolved = resolveMessageAttachments(message, (attachmentId) => takeAttachment(attachmentId, client.room));
  if (!resolved.ok) {
    if (message.messageId) {
      await sendDeliveryReceipt(client, message.messageId, "rejected", ATTACHMENT_MISSING_ERROR);
    }
    return "rejected";
  }
  await input.onProcessing?.();
  await say(`Creating a new ${displayName} task…`, undefined, false, "status");
  const create = {
    claude: createClaudeSession,
    codex: createCodexSession,
    cursor: createCursorSession,
    grok: createGrokSession,
  }[agent];
  const result = await create(
    message.text, requestedCwd, DELIVERY_TIMEOUT_MS, resolved.attachments, message.model, undefined, message.effort,
  );
  if (result.ok) {
    await say(result.text, result.sessionId, true);
    return "accepted";
  } else {
    await say(`Could not create a ${displayName} task: ${result.error}`, undefined, true);
    return "rejected";
  }
}

export async function handleUserMessage(
  client: RelayClient,
  message: UserMessage,
  onProcessing?: () => Promise<void>,
): Promise<"accepted" | "rejected"> {
  const say = (text: string, sessionId?: string, wake = false, kind: "status" | "response" = "response") => {
    const payload = agentEventForUserMessage(message, text, sessionId, kind);
    const options = { ttlMs: 15 * 60_000, wake: wake || undefined };
    return (sessionId
      ? sendSessionPayload(client, payload, sessionId, "phone", options)
      : client.send(payload, "phone", options)).catch(() => {});
  };
  if (!message.sessionId) {
    return startNewAgentTask({ client, message, say, onProcessing });
  }
  const resolved = resolveMessageAttachments(message, (attachmentId) => takeAttachment(attachmentId, client.room));
  if (!resolved.ok) {
    if (message.messageId) {
      await sendDeliveryReceipt(client, message.messageId, "rejected", ATTACHMENT_MISSING_ERROR, message.sessionId);
    }
    return "rejected";
  }
  const attachments = resolved.attachments;

  const target = scanSessions().sessions.find((session) => session.sessionId === message.sessionId);
  if (!target) {
    await say("This task is no longer available on the computer.", message.sessionId);
    return "rejected";
  }

  const settings = loadRuntimeConfig().providerSettings;
  if (target.agent in settings
    && settings[target.agent as keyof typeof settings] === false) {
    await say("This agent is disabled in GrantTap Settings.", message.sessionId, true);
    return "rejected";
  }

  const routingError = deliveryRoutingError(target, message);
  if (routingError) {
    await say(routingError, target.sessionId);
    return "rejected";
  }

  // No "sent, waiting" line from a middleman: the delivery receipt already
  // marks the person's bubble, and the next words in the chat are the answer.
  await onProcessing?.();
  const startedAt = Date.now();
  const result = await deliverToSession(target, message.text, DELIVERY_TIMEOUT_MS, attachments, {
    preferredMcp: message.preferredMcp,
    skill: message.skill,
    model: message.model,
    permissionMode: message.permissionMode,
    effort: message.effort,
  });
  // The run's turns are in the transcript, but a session holding this chat
  // open never sees them; the journal is how it finds out on its next prompt,
  // and the Task carries the same digest as progress.
  const noted = noteDeliveredRun({
    session: target,
    prompt: message.text,
    result,
    startedAt,
    endedAt: Date.now(),
  });
  if (noted?.event) {
    await sendSessionPayload(client, noted.event, noted.event.taskId, "phone", { ttlMs: 24 * 60 * 60_000 })
      .catch(() => {});
  }
  if (result.ok) {
    await say(result.text, result.sessionId ?? target.sessionId, true);
    return "accepted";
  } else {
    await say(`Could not deliver the message: ${result.error}`, target.sessionId, true);
    return "rejected";
  }
}
