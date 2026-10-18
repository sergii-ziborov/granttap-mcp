import { randomUUID } from "node:crypto";
import type { SessionInfo } from "../../../../../packages/protocol/schema";
import { runProcess } from ".";
import { providerEffortArgs } from "./provider-effort";
import type { ReplyResult } from "../payload/types";
import type { DeliveryOptions } from "../payload/types";
import { resolveGrokBinary } from "../../providers/grok-bin";
import { runCursorConversation } from "../cursor-conversation";

function grokBin(): string {
  return resolveGrokBinary();
}

function parseGrok(stdout: string, fallback: string): ReplyResult {
  let text = "";
  let sessionId = fallback;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as {
        type?: string; data?: unknown; sessionId?: unknown; session_id?: unknown;
        result?: unknown; error?: unknown;
      };
      if (value.type === "text" && typeof value.data === "string") text += value.data;
      if (value.type === "result" && typeof value.result === "string") text = value.result;
      if (typeof value.sessionId === "string") sessionId = value.sessionId;
      if (typeof value.session_id === "string") sessionId = value.session_id;
      if (value.type === "error" && typeof value.error === "string") {
        return { ok: false, error: value.error.slice(0, 500) };
      }
    } catch {
      // Ignore diagnostic lines outside Grok's streaming JSON contract.
    }
  }
  const visible = text.trim() || stdout.trim();
  return visible
    ? { ok: true, text: visible.slice(0, 4_000), sessionId }
    : { ok: false, error: "Grok Build returned an empty response." };
}

export function runCursorNew(
  text: string, cwd: string, timeoutMs: number, model?: string, operationKey?: string, effort?: string,
): Promise<ReplyResult> {
  return runCursorConversation({ text, cwd, timeoutMs, model, operationKey });
}

export async function runCursorResume(
  session: SessionInfo, text: string, timeoutMs: number, model?: string,
): Promise<ReplyResult> {
  if (!session.cwd) return Promise.resolve({ ok: false,
    error: "Cursor has not reported this task's workspace. Open the task in Cursor and retry." });
  return runCursorConversation({ session, text, cwd: session.cwd, timeoutMs, model: model ?? session.model });
}

export function runGrokNew(
  text: string, cwd: string, timeoutMs: number, model?: string, operationKey?: string, effort?: string,
): Promise<ReplyResult> {
  const sessionId = randomUUID();
  const args = [
    "--no-auto-update", "--cwd", cwd, "--session-id", sessionId,
    ...(model ? ["--model", model] : []), ...providerEffortArgs("grok", effort),
    "-p", text, "--output-format", "streaming-json",
  ];
  return runProcess(grokBin(), args, cwd, timeoutMs, (stdout) => parseGrok(stdout, sessionId),
    undefined, operationKey);
}

export function runGrokResume(
  session: SessionInfo, text: string, timeoutMs: number, options: DeliveryOptions = {},
): Promise<ReplyResult> {
  const permission = options.permissionMode === "manual" ? "default" : options.permissionMode;
  const args = [
    "--no-auto-update", ...(session.cwd ? ["--cwd", session.cwd] : []),
    ...(options.model ? ["--model", options.model] : []),
    ...(permission ? ["--permission-mode", permission] : []),
    ...providerEffortArgs("grok", options.effort),
    "--resume", session.sessionId, "-p", text, "--output-format", "streaming-json",
  ];
  return runProcess(
    grokBin(), args, session.cwd, timeoutMs,
    (stdout) => parseGrok(stdout, session.sessionId),
    undefined, session.sessionId,
  );
}
