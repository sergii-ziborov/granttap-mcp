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
  type ReplyResult,
} from "../../reply";
import { acceptInstanceEpoch } from "../../host/instance-epoch";
import { evaluateCreateTask } from "../../mesh/tasks/create-task";
import { recordDelegation } from "../../mesh/handoff/delegation-loop";
import { enqueuePinnedTask } from "../../mesh/tasks/queue";
import { sendSessionPayload } from "../../host/session-keys";
import { resolveMessageAttachments } from "./receipts";
import { acceptWhenStarted, PHONE_RUN_LIMIT_MS } from "../message-delivery/acceptance";

export type TaskCreateAdmission =
  | { status: "accepted" }
  | { status: "rejected"; error: string };

export async function handleTaskCreate(
  client: RelayClient,
  message: TaskCreate,
  onProcessing?: () => Promise<void>,
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
  if (!onProcessing && !acceptInstanceEpoch(message.instanceEpoch, loadConfigCommandState().requireFreshCommands)) {
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
    if (onProcessing) return { status: "rejected", error: "The pinned host is unavailable." };
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
  await onProcessing?.();
  await say(`Creating a new ${displayName} task…`);
  const create = {
    claude: createClaudeSession,
    codex: createCodexSession,
    cursor: createCursorSession,
    grok: createGrokSession,
  }[agent];
  const run = create(
    message.text, message.cwd, PHONE_RUN_LIMIT_MS, resolved.attachments, message.model,
    message.operationId,
  );
  const settle = (result: ReplyResult, late: boolean) => result.ok
    ? say(result.text, result.sessionId, true)
    : say(late ? `The ${displayName} task stopped: ${result.error}`
      : `Could not create a ${displayName} task: ${result.error}`, undefined, true);
  const early = await acceptWhenStarted(run, (result) => settle(result, true));
  if (early === "started") return { status: "accepted" };
  await settle(early, false);
  return early.ok ? { status: "accepted" } : { status: "rejected", error: "Provider delivery failed." };
}
