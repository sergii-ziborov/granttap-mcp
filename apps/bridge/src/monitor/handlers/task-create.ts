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
import { resolveMessageAttachments } from "./receipts";
import { DELIVERY_TIMEOUT_MS } from "./receipts";

export type TaskCreateAdmission =
  | { status: "accepted" }
  | { status: "rejected"; error: string };

export async function handleTaskCreate(
  client: RelayClient,
  message: TaskCreate,
): Promise<TaskCreateAdmission> {
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
    const error = "This command was issued for a previous instance of this computer.";
    await say(error, undefined, true);
    return { status: "rejected", error };
  }
  const loop = recordDelegation({
    operationId: message.operationId,
    parentSessionId: message.parentSessionId,
  });
  if (!loop.ok) {
    const error = "This bot cannot create another task from a delegated task.";
    await say(error, undefined, true);
    return { status: "rejected", error };
  }
  const agent = message.agent ?? "codex";
  const displayName = {
    claude: "Claude Code", codex: "Codex", cursor: "Cursor", grok: "Grok Build",
  }[agent];
  if (!loadRuntimeConfig().providerSettings[agent]) {
    const error = `${displayName} is disabled in GrantTap Settings.`;
    await say(error, undefined, true);
    return { status: "rejected", error };
  }
  const resolved = resolveMessageAttachments(
    { attachmentRefs: message.attachmentRefs, attachments: message.attachments },
    (attachmentId) => takeAttachment(attachmentId, client.room),
  );
  if (!resolved.ok) {
    return { status: "rejected", error: ATTACHMENT_MISSING_ERROR };
  }
  const admitted = evaluateCreateTask({
    cwd: message.cwd, agent, model: message.model,
    projectId: message.projectId,
    hostOnline: client.isConnected,
  });
  if (!admitted.ok) {
    await say(admitted.detail, undefined, true);
    return { status: "rejected", error: admitted.detail };
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
    return { status: "accepted" };
  }
  await say(`Creating a new ${displayName} task…`);
  const create = {
    claude: createClaudeSession,
    codex: createCodexSession,
    cursor: createCursorSession,
    grok: createGrokSession,
  }[agent];
  const result = await create(
    message.text, message.cwd, DELIVERY_TIMEOUT_MS, resolved.attachments, message.model,
    message.operationId,
  );
  if (result.ok) {
    await say(result.text, result.sessionId, true);
  } else {
    await say(`Could not create a ${displayName} task: ${result.error}`, undefined, true);
  }
  return { status: "accepted" };
}
