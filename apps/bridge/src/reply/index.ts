/** Deliver phone messages into existing sessions or start a new Codex task. */
import { localTaskTransfers, localTransferContinuations } from "../task-transfer";
import { localRoutingRequests } from '../task-routing/requests';
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionInfo, UserAttachment } from "../../../../packages/protocol/schema";
import type { CodingAgent } from "../../../../packages/protocol/schema";
import { explainClaudeFailure, resolveClaudeBinary } from "../providers/claude-bin";
import { runCodex, runCodexNew } from "./process/codex-headless";
import { providerEffortArgs } from "./process/provider-effort";
import { configDir, isSessionPaused, loadRuntimeConfig, PAUSED_SESSION_REASON } from "../config";
import { withAttachments } from "./payload/attachments";
import { abortProcesses, runProcess } from "./process";
import { routingPrompt } from "./payload/routing";
import type { DeliveryOptions, ReplyResult } from "./payload/types";
import {
  runCursorNew,
  runCursorResume,
  runGrokNew,
  runGrokResume,
} from "./process/provider-headless";
export type { DeliveryOptions, ReplyResult } from "./payload/types";

export const GENERAL_WORKSPACE = "granttap:general";

export function resolveAgentWorkspace(cwd: string | undefined, agent: CodingAgent): string {
  if (cwd && cwd !== GENERAL_WORKSPACE) return cwd;
  const path = join(configDir(), "workspaces", `general-${agent}`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

const inFlight = new Map<string, Promise<ReplyResult | null>>();

export function isDeliveryInFlight(sessionId: string): boolean { return inFlight.has(sessionId); }

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
  if (/^transfer-[a-f0-9]{48}$/.test(session.sessionId)) {
    return queued(session.sessionId, async () => (await localTaskTransfers().deliver(
      session.sessionId, text, attachments, options, {
        start: request => ({ claude: createClaudeSession, codex: createCodexSession,
          cursor: createCursorSession, grok: createGrokSession }[request.provider])(
          request.text, request.cwd, timeoutMs, request.attachments, request.model, request.operationKey, request.effort),
        resume: (native, body, images, settings) => withAttachments(images, body, prepared => runDelivery(native,
          native.agent === "codex" ? prepared.prompt : prepared.claudePrompt, timeoutMs, prepared.images, settings)),
      },
    )) ?? { ok: false, error: "The prepared transfer is unavailable." });
  }
  return queued(session.sessionId, () => withAttachments(attachments, text, (prepared) =>
    runDelivery(
      session,
      session.agent === "codex" ? prepared.prompt : prepared.claudePrompt,
      timeoutMs,
      prepared.images,
      options,
    ),
  ));
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
  return queued("__new_codex_task__", () => withAttachments(attachments, text, (prepared) =>
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
): Promise<ReplyResult> {
  const workspace = resolveAgentWorkspace(cwd, "claude");
  return queued("__new_claude_task__", () => withAttachments(attachments, text, (prepared) =>
    runClaudeNew(prepared.claudePrompt, workspace, timeoutMs, model, operationKey, effort),
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
): Promise<ReplyResult> {
  const workspace = resolveAgentWorkspace(cwd, "cursor");
  return queued("__new_cursor_task__", () => withAttachments(attachments, text, (prepared) =>
    runCursorNew(prepared.claudePrompt, workspace, timeoutMs, model, operationKey, effort),
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
): Promise<ReplyResult> {
  const workspace = resolveAgentWorkspace(cwd, "grok");
  return queued("__new_grok_task__", () => withAttachments(attachments, text, (prepared) =>
    runGrokNew(prepared.claudePrompt, workspace, timeoutMs, model, operationKey, effort),
  ));
}

function queued(key: string, run: () => Promise<ReplyResult>): Promise<ReplyResult> {
  const previous = inFlight.get(key) ?? Promise.resolve(null);
  const next = previous.then(run);
  const settled = next.finally(() => {
    if (inFlight.get(key) === tracked) inFlight.delete(key);
  });
  const tracked = settled.catch(() => null);
  inFlight.set(key, tracked);
  return settled;
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
  return runProcess(claude.path, args, session.cwd, timeoutMs, (stdout) => {
    try {
      const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean };
      if (parsed.is_error) {
        return { ok: false, error: explainClaudeFailure(parsed.result ?? "agent error", claude) };
      }
      if (typeof parsed.result === "string") return { ok: true, text: parsed.result };
    } catch {
      // Fall through to the plain output fallback.
    }
    const trimmed = stdout.trim();
    return trimmed
      ? { ok: true, text: trimmed.slice(0, 4000) }
      : { ok: false, error: "Claude returned an empty response." };
  }, undefined, session.sessionId);
}

function runClaudeNew(
  text: string, cwd: string, timeoutMs: number, model?: string, operationKey?: string, effort?: string,
): Promise<ReplyResult> {
  const args = ["-p", ...(model ? ["--model", model] : []), ...providerEffortArgs("claude", effort), "--output-format", "json", text];
  const claude = resolveClaudeBinary();
  return runProcess(claude.path, args, cwd, timeoutMs, (stdout) => {
    try {
      const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean; session_id?: string };
      if (parsed.is_error) {
        return { ok: false, error: explainClaudeFailure(parsed.result ?? "agent error", claude) };
      }
      if (typeof parsed.result === "string") {
        return { ok: true, text: parsed.result.slice(0, 4000), sessionId: parsed.session_id };
      }
    } catch {
      // Fall through to plain output.
    }
    const trimmed = stdout.trim();
    return trimmed
      ? { ok: true, text: trimmed.slice(0, 4000) }
      : { ok: false, error: "Claude returned an empty response." };
  }, undefined, operationKey);
}
