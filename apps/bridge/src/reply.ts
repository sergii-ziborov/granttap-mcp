/** Deliver phone messages into existing sessions or start a new Codex task. */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionInfo, UserAttachment } from "../../../packages/protocol/schema";
import type { CodingAgent } from "../../../packages/protocol/schema";
import { configDir, loadRuntimeConfig } from "./config";
import { withAttachments } from "./reply/attachments";
import { runProcess } from "./reply/process";
import { routingPrompt } from "./reply/routing";
import type { DeliveryOptions, ReplyResult } from "./reply/types";
import {
  runCursorNew,
  runCursorResume,
  runGrokNew,
  runGrokResume,
} from "./reply/provider-headless";
export type { DeliveryOptions, ReplyResult } from "./reply/types";

const CLAUDE_BIN = process.env.GRANTTAP_CLAUDE_BIN ?? process.env.NODVOX_CLAUDE_BIN ?? "claude";
const CODEX_BIN = process.env.GRANTTAP_CODEX_BIN ?? process.env.NODVOX_CODEX_BIN ?? "codex";
export const GENERAL_WORKSPACE = "granttap:general";

export function resolveAgentWorkspace(cwd: string | undefined, agent: CodingAgent): string {
  if (cwd && cwd !== GENERAL_WORKSPACE) return cwd;
  const path = join(configDir(), "workspaces", `general-${agent}`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

const inFlight = new Map<string, Promise<ReplyResult>>();

export function deliverToSession(
  session: SessionInfo,
  text: string,
  timeoutMs = 240_000,
  attachments: UserAttachment[] = [],
  options: DeliveryOptions = {},
): Promise<ReplyResult> {
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
): Promise<ReplyResult> {
  const workspace = resolveAgentWorkspace(cwd, "codex");
  return queued("__new_codex_task__", () => withAttachments(attachments, text, (prepared) =>
    runCodexNew(prepared.prompt, workspace, timeoutMs, prepared.images),
  ));
}

/** Start a persisted non-interactive Claude Code task for local scheduling. */
export function createClaudeSession(
  text: string,
  cwd?: string,
  timeoutMs = 240_000,
  attachments: UserAttachment[] = [],
): Promise<ReplyResult> {
  const workspace = resolveAgentWorkspace(cwd, "claude");
  return queued("__new_claude_task__", () => withAttachments(attachments, text, (prepared) =>
    runClaudeNew(prepared.claudePrompt, workspace, timeoutMs),
  ));
}

export function createCursorSession(
  text: string,
  cwd?: string,
  timeoutMs = 240_000,
  attachments: UserAttachment[] = [],
): Promise<ReplyResult> {
  const workspace = resolveAgentWorkspace(cwd, "cursor");
  return queued("__new_cursor_task__", () => withAttachments(attachments, text, (prepared) =>
    runCursorNew(prepared.claudePrompt, workspace, timeoutMs),
  ));
}

export function createGrokSession(
  text: string,
  cwd?: string,
  timeoutMs = 240_000,
  attachments: UserAttachment[] = [],
): Promise<ReplyResult> {
  const workspace = resolveAgentWorkspace(cwd, "grok");
  return queued("__new_grok_task__", () => withAttachments(attachments, text, (prepared) =>
    runGrokNew(prepared.claudePrompt, workspace, timeoutMs),
  ));
}

function queued(key: string, run: () => Promise<ReplyResult>): Promise<ReplyResult> {
  const previous = inFlight.get(key) ?? Promise.resolve(null);
  const next = previous.then(run);
  inFlight.set(
    key,
    next.catch(() => null as never),
  );
  return next;
}

function runDelivery(
  session: SessionInfo,
  text: string,
  timeoutMs: number,
  images: string[],
  options: DeliveryOptions,
): Promise<ReplyResult> {
  const routed = routingPrompt(session, text, options);
  if (session.agent === "claude") return runClaude(session, routed, timeoutMs);
  if (session.agent === "codex") return runCodex(session, routed, timeoutMs, images);
  if (session.agent === "cursor") return runCursorResume(session, routed, timeoutMs);
  if (session.agent === "grok") return runGrokResume(session, routed, timeoutMs);
  return Promise.resolve({ ok: false, error: `unknown agent: ${session.agent}` });
}

function runClaude(session: SessionInfo, text: string, timeoutMs: number): Promise<ReplyResult> {
  const disabled = loadRuntimeConfig().sessionMcpDisabled[session.sessionId] ?? [];
  const mcpArgs = disabled.length === 0
    ? []
    : ["--disallowedTools", disabled.map((name) => `mcp__${name}`).join(",")];
  const args = ["-p", "--resume", session.sessionId, ...mcpArgs, "--output-format", "json", text];
  return runProcess(CLAUDE_BIN, args, session.cwd, timeoutMs, (stdout) => {
    try {
      const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean };
      if (parsed.is_error) return { ok: false, error: parsed.result ?? "agent error" };
      if (typeof parsed.result === "string") return { ok: true, text: parsed.result };
    } catch {
      // Fall through to the plain output fallback.
    }
    const trimmed = stdout.trim();
    return trimmed
      ? { ok: true, text: trimmed.slice(0, 4000) }
      : { ok: false, error: "Claude returned an empty response." };
  });
}

function runClaudeNew(text: string, cwd: string, timeoutMs: number): Promise<ReplyResult> {
  const args = ["-p", "--output-format", "json", text];
  return runProcess(CLAUDE_BIN, args, cwd, timeoutMs, (stdout) => {
    try {
      const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean; session_id?: string };
      if (parsed.is_error) return { ok: false, error: parsed.result ?? "agent error" };
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
  });
}

function parseCodexJsonl(stdout: string, fallbackSessionId?: string): ReplyResult {
  let lastMessage = "";
  let sessionId = fallbackSessionId;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        thread_id?: string;
        session_id?: string;
        item?: { type?: string; text?: string };
      };
      if (event.type === "thread.started") {
        sessionId = event.thread_id ?? event.session_id ?? sessionId;
      }
      if (event.item?.type === "agent_message" && typeof event.item.text === "string") {
        lastMessage = event.item.text;
      }
    } catch {
      // Ignore non-JSON diagnostic lines.
    }
  }
  if (lastMessage) return { ok: true, text: lastMessage.slice(0, 4000), sessionId };
  const trimmed = stdout.trim();
  return trimmed
    ? { ok: true, text: trimmed.slice(0, 4000), sessionId }
    : { ok: false, error: "Codex returned an empty response." };
}

function runCodex(
  session: SessionInfo,
  text: string,
  timeoutMs: number,
  images: string[] = [],
): Promise<ReplyResult> {
  const configured = loadRuntimeConfig().sessionAccess[session.sessionId];
  const disabledMcp = loadRuntimeConfig().sessionMcpDisabled[session.sessionId] ?? [];
  const sandbox = configured === "read-only"
    ? "read-only"
    : configured === "workspace"
      ? "workspace-write"
      : configured === "full"
        ? "danger-full-access"
        : null;
  const accessArgs = sandbox ? ["-c", `sandbox_mode="${sandbox}"`] : [];
  const mcpArgs = disabledMcp.flatMap((name) => [
    "-c",
    `mcp_servers.${tomlKey(name)}.enabled=false`,
  ]);
  const imageArgs = images.flatMap((path) => ["-i", path]);
  const args = ["exec", "resume", ...accessArgs, ...mcpArgs, ...imageArgs, session.sessionId, "--json", "-"];
  return runProcess(
    CODEX_BIN,
    args,
    session.cwd,
    timeoutMs,
    (stdout) => parseCodexJsonl(stdout, session.sessionId),
    text,
  );
}

function tomlKey(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function runCodexNew(
  text: string,
  cwd: string,
  timeoutMs: number,
  images: string[] = [],
): Promise<ReplyResult> {
  // This is the supported non-interactive Codex path. It preserves the user's
  // normal sandbox, approval, hooks, model, and auth configuration.
  const imageArgs = images.flatMap((path) => ["-i", path]);
  const args = ["exec", ...imageArgs, "--json", "--skip-git-repo-check", "-"];
  return runProcess(CODEX_BIN, args, cwd, timeoutMs, parseCodexJsonl, text);
}
