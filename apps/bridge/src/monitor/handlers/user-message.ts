import { projectGuidancePrompt } from "../../mesh/restrictions/guidance";
import { withQueueNote } from "../../task-dispatch/queue-note";
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
  type ReplyResult,
} from "../../reply";
import { evaluateCreateTask } from "../../mesh/tasks/create-task";
import { sendSessionPayload } from "../../host/session-keys";
import { deliveryTarget } from "../../sessions";
import { publishedSession } from "../../session-catalog";
import { localTaskOrigins, type TaskOriginRegistry, type TaskOriginScope } from '../../task-origins';
import { agentEventForUserMessage, sendDeliveryReceipt } from "./receipts";
import { resolveMessageAttachments } from "./receipts";
import { reportMessageAgentActivity } from '../message-delivery/activity';
import { ACCEPTANCE_WINDOW_MS, acceptWhenStarted, PHONE_RUN_LIMIT_MS } from "../message-delivery/acceptance";
import { chatReplyHandle, newTaskHandle, sentMessage, settleChatReply, settleNewTask } from "../message-delivery/late-results";
import { withSurvivor } from "../../reply/survival";

async function startNewAgentTask(input: {
  client: RelayClient;
  message: UserMessage;
  say: (text: string, sessionId?: string, wake?: boolean, kind?: "status" | "response") => Promise<unknown>;
  onProcessing?: () => Promise<void>;
  origin?: { registry: TaskOriginRegistry; scope: TaskOriginScope };
  peerPublicKey?: string;
  queuedBehind?: () => number;
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
  let admittedProjectId: string | undefined;
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
    admittedProjectId = admitted.projectId;
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
  // Claude, Grok and Cursor name the chat as it starts; Codex only when its run ends.
  const started = (sessionId: string) => {
    try { input.origin?.registry.started(input.origin.scope, sessionId); } catch { /* The run's end records it. */ }
  };
  // Follow-ups written before this chat existed reach it after its first turn.
  const prompt = projectGuidancePrompt(admittedProjectId, withQueueNote(message.text, input.queuedBehind?.()));
  const outcome = { message: sentMessage(message), peerPublicKey: input.peerPublicKey, displayName,
    origin: input.origin?.scope };
  // The run can outlive this monitor; the handle says how its answer reaches the phone then.
  const handle = newTaskHandle(outcome);
  let run: Promise<ReplyResult>;
  try {
    run = withSurvivor(handle, () => agent === 'codex'
      ? createCodexSession(prompt, requestedCwd, PHONE_RUN_LIMIT_MS, resolved.attachments, message.model, message.messageId,
        message.effort)
      : { claude: createClaudeSession, cursor: createCursorSession, grok: createGrokSession }[agent](prompt, requestedCwd,
        PHONE_RUN_LIMIT_MS, resolved.attachments, message.model, message.messageId, message.effort, started)).catch(() => {
      input.origin?.registry.complete(input.origin.scope, { ok: true });
      return { ok: false, error: 'The provider task stopped unexpectedly.' } as ReplyResult;
    });
  } catch {
    input.origin?.registry.complete(input.origin.scope, { ok: false });
    await say(`Could not create a ${displayName} task on this computer.`, undefined, true);
    return 'rejected';
  }
  const settle = (result: ReplyResult, late: boolean) => settleNewTask(client, outcome, result, late);
  const early = await acceptWhenStarted(run, (result) => settle(result, true), ACCEPTANCE_WINDOW_MS, handle);
  if (early === "started") return "accepted";
  await settle(early, false);
  return early.ok || early.delivery === 'native' ? "accepted" : "rejected";
}

export async function handleUserMessage(
  client: RelayClient,
  message: UserMessage,
  onProcessing?: () => Promise<void>,
  peerPublicKey?: string,
  native?: { messageId: string; questionReply: true },
  onRefusal?: (error: string) => Promise<void>,
  /** Phone messages queued for the same chat behind this one; the prompt says how many. */
  queuedBehind?: () => number,
): Promise<"accepted" | "rejected"> {
  const say = (text: string, sessionId?: string, wake = false, kind: "status" | "response" = "response") => {
    const payload = agentEventForUserMessage(message, text, sessionId, kind);
    const options = { ttlMs: 15 * 60_000, wake: wake || undefined, peerPublicKey };
    return (sessionId
      ? sendSessionPayload(client, payload, sessionId, "phone", options)
      : client.send(payload, "phone", options)).catch(() => {});
  };
  const refuse = async (error: string, wake = false): Promise<"rejected"> => {
    await onRefusal?.(error);
    await say(error, message.sessionId, wake);
    return "rejected";
  };
  if (!message.sessionId) {
    const origin = message.taskOriginId && peerPublicKey ? {
      registry: localTaskOrigins(),
      scope: { room: client.room, peerPublicKey, originMessageId: message.taskOriginId },
    } : undefined;
    return startNewAgentTask({ client, message, say, onProcessing, origin, peerPublicKey, queuedBehind });
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
  const target = await deliveryTarget(publishedSession(client, message.sessionId), message.sessionId);
  if (!target) return refuse("This task is no longer available on the computer.");

  const settings = loadRuntimeConfig().providerSettings;
  if (target.agent in settings
    && settings[target.agent as keyof typeof settings] === false) {
    return refuse("This agent is disabled in GrantTap Settings.", true);
  }

  const routingError = deliveryRoutingError(target, message);
  if (routingError) return refuse(routingError);

  // No "sent, waiting" line from a middleman: the delivery receipt already
  // marks the person's bubble, and the next words in the chat are the answer.
  await onProcessing?.();
  const reply = { message: sentMessage(message), peerPublicKey, target, startedAt: Date.now() };
  // The run can outlive this monitor; the handle says how its answer reaches the phone then.
  const handle = chatReplyHandle(reply);
  const run = withSurvivor(handle, () => deliverToSession(target, message.text, PHONE_RUN_LIMIT_MS, attachments, {
    messageId: native?.messageId ?? message.messageId,
    questionReply: native?.questionReply,
    onAgentActivity: () => reportMessageAgentActivity(client, message, peerPublicKey),
    preferredMcp: message.preferredMcp,
    skill: message.skill,
    model: message.model,
    permissionMode: message.permissionMode,
    effort: message.effort, queuedBehind,
  }));
  const settle = (result: ReplyResult, late: boolean) => settleChatReply(client, reply, result, late);
  const early = await acceptWhenStarted(run, (result) => settle(result, true), ACCEPTANCE_WINDOW_MS, handle);
  if (early === "started") return "accepted";
  await settle(early, false);
  return early.ok || early.delivery === 'native' ? "accepted" : "rejected";
}
