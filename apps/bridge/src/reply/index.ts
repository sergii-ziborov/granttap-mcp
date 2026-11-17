import { projectGuidancePrompt } from "../mesh/restrictions/guidance";
/** Deliver phone messages into existing sessions or start a new Codex task. */
import { localTaskTransfers, localTransferContinuations } from "../task-transfer";
import { localRoutingRequests } from '../task-routing/requests';
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionInfo, UserAttachment } from "../../../../packages/protocol/schema";
import type { CodingAgent } from "../../../../packages/protocol/schema";
import { resolveClaudeBinary } from "../providers/claude-bin";
import { parseClaudeResult } from "./payload/claude-result";
import { runCodex, runCodexNew } from "./process/codex-headless";
import { providerEffortArgs } from "./process/provider-effort";
import { configDir, isSessionPaused, loadRuntimeConfig, PAUSED_SESSION_REASON } from "../config";
import { withAttachments } from "./payload/attachments";
import { abortProcesses, runProcess } from "./process";
import { routingPrompt } from "./payload/routing";
import type { DeliveryOptions, ReplyResult } from "./payload/types";
import { deliveryIntent } from './payload/identity';
import { phoneMessagesWaiting, queued } from "./in-flight";
import { withoutSurvivor } from "./survival";
import { withQueueNote } from "../task-dispatch/queue-note";
import {
  runCursorNew,
  runCursorResume,
  runGrokNew,
  runGrokResume,
} from "./process/provider-headless";
export type { DeliveryOptions, ReplyResult } from "./payload/types";
export { prunePreparedAttachments } from './payload/attachments';
export { hasPendingDeliveries, isDeliveryInFlight, oldestDeliveryStartedAt } from "./in-flight";

export const GENERAL_WORKSPACE = "granttap:general";

export function resolveAgentWorkspace(cwd: string | undefined, agent: CodingAgent): string {
  if (cwd && cwd !== GENERAL_WORKSPACE) return cwd;
  const path = join(configDir(), "workspaces", `general-${agent}`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

/** New tasks are separate conversations: one long run must not hold back the next. */
export function newTaskDeliveryKey(agent: string, operationKey?: string): string {
  return `__new_${agent}_task__${operationKey ? `:${operationKey}` : ''}`;
}

/** Request a stop for owned processes; confirmation arrives only on process exit. */
export function stopDeliveries(sessionId: string): number {
  try { localRoutingRequests().cancel(sessionId); } catch { /* The native stop still runs when storage is unavailable. */ }
  const native = localTaskTransfers().nativeSession({ sessionId } as SessionInfo).sessionId;
  return abortProcesses(sessionId) + (native === sessionId ? 0 : abortProcesses(native));
}

export function deliverToSession(
  session: SessionInfo,
  text: string,
  timeoutMs = 240_000,
  attachments: UserAttachment[] = [],
  options: DeliveryOptions = {},
): Promise<ReplyResult> {
  const transferred = localTransferContinuations().blockReason(session.sessionId);
  if (transferred) return Promise.resolve({ ok: false, error: transferred });
  try {
    const routing = localRoutingRequests().blockReason(session.sessionId);
    if (routing) return Promise.resolve({ ok: false, error: routing });
  } catch { return Promise.resolve({ ok: false, error: 'The automatic transfer journal is unavailable.' }); }
  // A held chat takes no new turn either: the pause is the person's, and a
  // message from the phone would otherwise quietly restart the work.
  if (!options.ignorePause && isSessionPaused(session.sessionId)) {
    return Promise.resolve({ ok: false, error: PAUSED_SESSION_REASON });
  }
  if (session.agent === 'codex') options = { ...options, intentDigest: deliveryIntent(text, attachments, options) };
  const phone = Boolean(options.messageId);
  // Read when the prompt is written: the durable queue's count and the phone messages waiting here behind this one.
  const behind = () => {
    let count = 0;
    try { count = typeof options.queuedBehind === 'function' ? options.queuedBehind() : options.queuedBehind ?? 0; }
    catch { /* An unreadable queue adds no line. */ }
    return count + (phone ? phoneMessagesWaiting(session.sessionId) : 0);
  };
  if (/^transfer-[a-f0-9]{48}$/.test(session.sessionId)) {
    // A moved Task's turn updates the transfer record when it ends, which only this monitor does.
    return withoutSurvivor(() => queued(session.sessionId, async () => (await localTaskTransfers().deliver(
      session.sessionId, text, attachments, { ...options, queuedBehind: behind() }, {
        start: request => request.provider === "grok"
          ? createGrokSession(projectGuidancePrompt(session.projectId, request.text), request.cwd, timeoutMs, request.attachments,
            request.model, request.operationKey, request.effort, nativeId => {
              request.onNativeSession(nativeId);
              options.onAgentActivity?.(nativeId);
            })
          : request.provider === 'cursor'
            ? createCursorSession(projectGuidancePrompt(session.projectId, request.text), request.cwd, timeoutMs,
              request.attachments, request.model, request.operationKey, request.effort, nativeId => {
                request.onNativeSession(nativeId);
              })
          : ({ claude: createClaudeSession, codex: createCodexSession }[request.provider])(projectGuidancePrompt(session.projectId, request.text), request.cwd,
            timeoutMs, request.attachments, request.model, request.operationKey, request.effort),
        resume: (native, body, images, settings) => withAttachments(images, body, prepared => runDelivery(native,
          native.agent === "codex" ? prepared.prompt : prepared.claudePrompt, timeoutMs, prepared.images, settings)),
      },
    )) ?? { ok: false, error: "The prepared transfer is unavailable." }, phone));
  }
  return queued(session.sessionId, () => withAttachments(attachments, withQueueNote(text, behind()), (prepared) =>
    runDelivery(
      session,
      session.agent === "codex" ? prepared.prompt : prepared.claudePrompt,
      timeoutMs,
      prepared.images,
      options,
    ),
  ), phone);
}

/** A message from the phone home screen intentionally creates a new task. */
export function createCodexSession(
  text: string,
  cwd?: string,
  timeoutMs = 240_000,
  attachments: UserAttachment[] = [],
  model?: string,
  operationKey?: string,
  effort?: string,
): Promise<ReplyResult> {
  const workspace = resolveAgentWorkspace(cwd, "codex");
  return queued(newTaskDeliveryKey("codex", operationKey), () => withAttachments(attachments, text, (prepared) =>
    runCodexNew(prepared.prompt, workspace, timeoutMs, prepared.images, model, operationKey, effort),
  ));
}

/** Start a persisted non-interactive Claude Code task for local scheduling. */
export function createClaudeSession(
  text: string,
  cwd?: string,
  timeoutMs = 240_000,
  attachments: UserAttachment[] = [],
  model?: string,
  operationKey?: string,
  effort?: string,
  onNativeSession?: (sessionId: string) => void,
): Promise<ReplyResult> {
  const workspace = resolveAgentWorkspace(cwd, "claude");
  return queued(newTaskDeliveryKey("claude", operationKey), () => withAttachments(attachments, text, (prepared) =>
    runClaudeNew(prepared.claudePrompt, workspace, timeoutMs, model, operationKey, effort, onNativeSession),
  ));
}

export function createCursorSession(
  text: string,
  cwd?: string,
  timeoutMs = 240_000,
  attachments: UserAttachment[] = [],
  model?: string,
  operationKey?: string,
  effort?: string,
  onNativeSession?: (sessionId: string) => void,
): Promise<ReplyResult> {
  const workspace = resolveAgentWorkspace(cwd, "cursor");
  return queued(newTaskDeliveryKey("cursor", operationKey), () => withAttachments(attachments, text, (prepared) =>
    runCursorNew(prepared.claudePrompt, workspace, timeoutMs, model, operationKey, effort, onNativeSession),
  ));
}

export function createGrokSession(
  text: string,
  cwd?: string,
  timeoutMs = 240_000,
  attachments: UserAttachment[] = [],
  model?: string,
  operationKey?: string,
  effort?: string,
  onNativeSession?: (sessionId: string) => void,
): Promise<ReplyResult> {
  const workspace = resolveAgentWorkspace(cwd, "grok");
  return queued(newTaskDeliveryKey("grok", operationKey), () => withAttachments(attachments, text, (prepared) =>
    runGrokNew(prepared.claudePrompt, workspace, timeoutMs, model, operationKey, effort, onNativeSession),
  ));
}

function runDelivery(
  session: SessionInfo,
  text: string,
  timeoutMs: number,
  images: string[],
  options: DeliveryOptions,
): Promise<ReplyResult> {
  const routed = routingPrompt(session, text, options);
  if (session.agent === "claude") return runClaude(session, routed, timeoutMs, options);
  if (session.agent === "codex") return runCodex(session, routed, timeoutMs, images, options);
  if (session.agent === "cursor") return runCursorResume(session, routed, timeoutMs, options.model);
  if (session.agent === "grok") return runGrokResume(session, routed, timeoutMs, options);
  return Promise.resolve({ ok: false, error: `unknown agent: ${session.agent}` });
}

function runClaude(
  session: SessionInfo,
  text: string,
  timeoutMs: number,
  options: DeliveryOptions,
): Promise<ReplyResult> {
  const disabled = loadRuntimeConfig().sessionMcpDisabled[session.sessionId] ?? [];
  const mcpArgs = disabled.length === 0
    ? []
    : ["--disallowedTools", disabled.map((name) => `mcp__${name}`).join(",")];
  const modelArgs = options.model ? ["--model", options.model] : [];
  const modeArgs = options.permissionMode
    ? ["--permission-mode", options.permissionMode]
    : [];
  const effortArgs = providerEffortArgs("claude", options.effort);
  const args = [
    "-p", "--resume", session.sessionId, ...mcpArgs, ...modelArgs,
    ...modeArgs, ...effortArgs,
    "--output-format", "json", text,
  ];
  // Chosen per delivery: the app may have installed a newer Claude Code since.
  const claude = resolveClaudeBinary();
  return runProcess(claude.path, args, session.cwd, timeoutMs, (stdout) => parseClaudeResult(stdout, claude),
    undefined, session.sessionId, undefined, { parser: { kind: "claude" } });
}

function runClaudeNew(
  text: string, cwd: string, timeoutMs: number, model?: string, operationKey?: string, effort?: string,
  onNativeSession?: (sessionId: string) => void,
): Promise<ReplyResult> {
  // The chat is given its id before it starts, so the phone can show the one chat it asked for
  // while the first answer is still being written, instead of a placeholder beside it.
  const sessionId = randomUUID();
  const args = ["-p", "--session-id", sessionId, ...(model ? ["--model", model] : []), ...providerEffortArgs("claude", effort),
    "--output-format", "json", text];
  const claude = resolveClaudeBinary();
  onNativeSession?.(sessionId);
  return runProcess(claude.path, args, cwd, timeoutMs, (stdout) => parseClaudeResult(stdout, claude, sessionId),
    undefined, operationKey, undefined, { parser: { kind: "claude-new", sessionId } });
}
