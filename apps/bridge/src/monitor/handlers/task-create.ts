import type { TaskCreate } from "../../../../../packages/protocol/schema";
import { ATTACHMENT_MISSING_ERROR } from "../../../../../packages/protocol/schema";
import type { RelayClient } from "../../../../../packages/core/relay-client";
import { takeAttachment } from "../../delivery/attachment-store";
import { loadRuntimeConfig } from "../../config";
import { loadConfigCommandState } from "../../config/commands";
import {
  createClaudeSession,
  createCodexSession,
  createCursorSession,
  createGrokSession,
} from "../../reply";
import { acceptInstanceEpoch } from "../../host/instance-epoch";
import { evaluateCreateTask } from "../../mesh/tasks/create-task";
import { recordDelegation } from "../../mesh/handoff/delegation-loop";
import { enqueuePinnedTask } from "../../mesh/tasks/queue";
import { sendSessionPayload } from "../../host/session-keys";
import { sendDeliveryReceipt } from "./receipts";
import { resolveMessageAttachments } from "./receipts";
import { DELIVERY_TIMEOUT_MS } from "./receipts";

export async function handleTaskCreate(
  client: RelayClient,
  message: TaskCreate,
): Promise<void> {
  const say = (text: string, sessionId?: string, wake = false) => {
    const payload = {
      type: "agent.event" as const,
      text,
      sessionId,
      createdAt: Date.now(),
    };
    const options = { ttlMs: 15 * 60_000, wake: wake || undefined };
    return (sessionId
      ? sendSessionPayload(client, payload, sessionId, "phone", options)
      : client.send(payload, "phone", options)).catch(() => {});
  };
  if (!acceptInstanceEpoch(message.instanceEpoch, loadConfigCommandState().requireFreshCommands)) {
    await say("This command was issued for a previous instance of this computer.", undefined, true);
    return;
  }
  const loop = recordDelegation({
    operationId: message.operationId,
    parentSessionId: message.parentSessionId,
  });
  if (!loop.ok) {
    await say("This bot cannot create another task from a delegated task.", undefined, true);
    return;
  }
  const agent = message.agent ?? "codex";
  const displayName = {
    claude: "Claude Code", codex: "Codex", cursor: "Cursor", grok: "Grok Build",
  }[agent];
  if (!loadRuntimeConfig().providerSettings[agent]) {
    await say(`${displayName} is disabled in GrantTap Settings.`, undefined, true);
    return;
  }
  const resolved = resolveMessageAttachments(
    { attachmentRefs: message.attachmentRefs, attachments: message.attachments },
    (attachmentId) => takeAttachment(attachmentId, client.room),
  );
  if (!resolved.ok) {
    await sendDeliveryReceipt(client, message.operationId, "rejected", ATTACHMENT_MISSING_ERROR);
    return;
  }
  const admitted = evaluateCreateTask({
    cwd: message.cwd, agent, model: message.model,
    projectId: message.projectId,
    hostOnline: client.isConnected,
  });
  if (!admitted.ok) {
    await say(admitted.detail, undefined, true);
    return;
  }
  if ("queued" in admitted && admitted.queued) {
    enqueuePinnedTask({
      operationId: message.operationId,
      projectId: admitted.projectId,
      text: message.text,
      cwd: message.cwd,
      agent,
      model: message.model,
    });
    await say("The pinned host is offline. The task is queued until the deadline.", undefined, true);
    return;
  }
  await say(`Creating a new ${displayName} task…`);
  const create = {
    claude: createClaudeSession,
    codex: createCodexSession,
    cursor: createCursorSession,
    grok: createGrokSession,
  }[agent];
  const result = await create(message.text, message.cwd, DELIVERY_TIMEOUT_MS, resolved.attachments);
  if (result.ok) {
    await say(result.text, result.sessionId, true);
  } else {
    await say(`Could not create a ${displayName} task: ${result.error}`, undefined, true);
  }
}
