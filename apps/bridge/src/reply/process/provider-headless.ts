import { grokAdmission, parseGrok } from "../grok-response";
import { randomUUID } from "node:crypto";
import type { SessionInfo } from "../../../../../packages/protocol/schema";
import { runProcess } from ".";
import { providerEffortArgs } from "./provider-effort";
import type { ReplyResult } from "../payload/types";
import type { DeliveryOptions } from "../payload/types";
import { resolveGrokBinary } from "../../providers/grok-bin";
import { runCursorConversation } from "../cursor-conversation";
import { grokResumeActivity } from '../../providers/grok-activity';

function grokBin(): string {
  return resolveGrokBinary();
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
    undefined, operationKey, grokAdmission);
}

export function runGrokResume(
  session: SessionInfo, text: string, timeoutMs: number, options: DeliveryOptions = {},
): Promise<ReplyResult> {
  const live = grokResumeActivity(session);
  if (live?.state === 'working' || live?.state === 'waiting') return Promise.resolve({ ok: false,
    error: live.state === 'working' ? 'Grok is still running a turn in this task. Wait for it to finish, then retry this message.'
      : 'Grok is waiting for permission in its open task. Resolve that request, then retry this message.' });
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
    undefined, session.sessionId, grokAdmission,
  );
}
