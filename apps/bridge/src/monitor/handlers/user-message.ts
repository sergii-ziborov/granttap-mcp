import type { UserMessage } from "../../../../../packages/protocol/schema";
import { ATTACHMENT_MISSING_ERROR } from "../../../../../packages/protocol/schema";
import type { RelayClient } from "../../../../../packages/core/relay-client";
import { takeAttachment } from "../../delivery/attachment-store";
import { rejectCompletedDelivery } from '../../delivery';
import { loadRuntimeConfig } from "../../config";
import { deliveryRoutingError } from "../../capabilities";
import {
  createClaudeSession,
  createCodexSession,
  createCursorSession,
  createGrokSession,
  deliverToSession,
  type ReplyResult,
} from "../../reply";
import { noteDeliveredRun } from "../../mesh/delivery/run-digest";
import { evaluateCreateTask } from "../../mesh/tasks/create-task";
import { sendSessionPayload } from "../../host/session-keys";
import { scanSessions } from "../../sessions";
import { publishedSession } from "../../session-catalog";
import { localTaskOrigins, type TaskOriginRegistry, type TaskOriginScope } from '../../task-origins';
import { agentEventForUserMessage, sendDeliveryReceipt } from "./receipts";
import { resolveMessageAttachments } from "./receipts";
import { reportMessageAgentActivity } from '../message-delivery/activity';
import { acceptWhenStarted, PHONE_RUN_LIMIT_MS } from "../message-delivery/acceptance";

async function startNewAgentTask(input: {
  client: RelayClient;
  message: UserMessage;
  say: (text: string, sessionId?: string, wake?: boolean, kind?: "status" | "response") => Promise<unknown>;
  onProcessing?: () => Promise<void>;
  origin?: { registry: TaskOriginRegistry; scope: TaskOriginScope };
  peerPublicKey?: string;
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
  const admission = input.origin?.registry.begin(input.origin.scope,
    { ...message, attachments: resolved.attachments, attachmentRefs: undefined });
  if (admission && admission.state !== 'started') {
    await say(admission.state === 'ready' ? 'This task has already been created.'
      : 'The original task is being created or needs confirmation before it can be retried.',
      admission.sessionId, false, 'status');
    return ['ready', 'waiting'].includes(admission.state) ? 'accepted' : 'rejected';
  }
  try { await input.onProcessing?.(); }
  catch (error) {
    if (input.origin) input.origin.registry.abandonBeforeStart(input.origin.scope);
    throw error;
  }
  await say(`Creating a new ${displayName} task…`, undefined, false, "status");
  const create = {
    claude: createClaudeSession,
    codex: createCodexSession,
    cursor: createCursorSession,
    grok: createGrokSession,
  }[agent];
  let run: Promise<ReplyResult>;
  try {
    run = create(message.text, requestedCwd, PHONE_RUN_LIMIT_MS, resolved.attachments,
      message.model, undefined, message.effort).catch(() => {
      input.origin?.registry.complete(input.origin.scope, { ok: true });
      return { ok: false, error: 'The provider task stopped unexpectedly.' } as ReplyResult;
    });
  } catch {
    input.origin?.registry.complete(input.origin.scope, { ok: false });
    await say(`Could not create a ${displayName} task on this computer.`, undefined, true);
    return 'rejected';
  }
  const settle = async (result: ReplyResult, late: boolean) => {
    input.origin?.registry.complete(input.origin.scope,
      { ok: result.ok || result.delivery === 'native', sessionId: result.ok ? result.sessionId : undefined });
    if (!result.ok && message.messageId && result.delivery !== 'native') {
      if (late) rejectCompletedDelivery(message.messageId, result.error);
      await sendDeliveryReceipt(client, message.messageId, 'rejected', result.error,
        undefined, input.peerPublicKey);
    }
    return result.ok ? say(result.text, result.sessionId, true)
      : say(late || result.delivery === 'native' ? `The ${displayName} task stopped: ${result.error}`
        : `Could not create a ${displayName} task: ${result.error}`, undefined, true);
  };
  const early = await acceptWhenStarted(run, (result) => settle(result, true));
  if (early === "started") return "accepted";
  await settle(early, false);
  return early.ok || early.delivery === 'native' ? "accepted" : "rejected";
}

export async function handleUserMessage(
  client: RelayClient,
  message: UserMessage,
  onProcessing?: () => Promise<void>,
  peerPublicKey?: string,
): Promise<"accepted" | "rejected"> {
  const say = (text: string, sessionId?: string, wake = false, kind: "status" | "response" = "response") => {
    const payload = agentEventForUserMessage(message, text, sessionId, kind);
    const options = { ttlMs: 15 * 60_000, wake: wake || undefined, peerPublicKey };
    return (sessionId
      ? sendSessionPayload(client, payload, sessionId, "phone", options)
      : client.send(payload, "phone", options)).catch(() => {});
  };
  if (!message.sessionId) {
    const origin = message.taskOriginId && peerPublicKey ? {
      registry: localTaskOrigins(),
      scope: { room: client.room, peerPublicKey, originMessageId: message.taskOriginId },
    } : undefined;
    return startNewAgentTask({ client, message, say, onProcessing, origin, peerPublicKey });
  }
  const resolved = resolveMessageAttachments(message, (attachmentId) => takeAttachment(attachmentId, client.room));
  if (!resolved.ok) {
    if (message.messageId) {
      await sendDeliveryReceipt(client, message.messageId, "rejected", ATTACHMENT_MISSING_ERROR, message.sessionId, peerPublicKey);
    }
    return "rejected";
  }
  const attachments = resolved.attachments;

  // The catalog this monitor last published already names the chat. A full
  // provider scan blocks the event loop for seconds on a large transcript set,
  // so it runs only for a chat newer than that catalog.
  const target = publishedSession(client, message.sessionId)
    ?? scanSessions().sessions.find((session) => session.sessionId === message.sessionId);
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
  const run = deliverToSession(target, message.text, PHONE_RUN_LIMIT_MS, attachments, {
    messageId: message.messageId,
    onAgentActivity: () => reportMessageAgentActivity(client, message, peerPublicKey),
    preferredMcp: message.preferredMcp,
    skill: message.skill,
    model: message.model,
    permissionMode: message.permissionMode,
    effort: message.effort,
  });
  const settle = async (result: ReplyResult, late: boolean) => {
    if (result.ok && result.delivery === 'native') return;
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
    if (result.ok) await say(result.text, result.sessionId ?? target.sessionId, true);
    else {
      if (result.delivery !== 'native') {
        if (late && message.messageId) rejectCompletedDelivery(message.messageId, result.error);
        if (message.messageId) await sendDeliveryReceipt(client, message.messageId, 'rejected',
          result.error, target.sessionId, peerPublicKey);
      }
      await say(late || result.delivery === 'native' ? `The run stopped: ${result.error}`
        : `Could not deliver the message: ${result.error}`,
        target.sessionId, true);
    }
  };
  const early = await acceptWhenStarted(run, (result) => settle(result, true));
  if (early === "started") return "accepted";
  await settle(early, false);
  return early.ok || early.delivery === 'native' ? "accepted" : "rejected";
}
