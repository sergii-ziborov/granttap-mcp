#!/usr/bin/env -S npx tsx
/** Cursor beforeShellExecution: exact chat block, otherwise phone/native approval. */
import {
  cursorToRequest,
  decisionToCursorOutput,
  type CursorHookInput,
} from "../adapters";
import { isUnanswered, requestApproval } from "../approval";
import {
  autoAcceptLevelFor,
  blockedSessionCapability,
  isGatingSkipped,
  isProviderEnabled,
  loadConfig,
  machineConfigPath,
  shouldAutoAcceptCursorShell,
} from "../config";
import { cursorRootSessionId } from "../sessions/cursor";
import { protectedGrantTapAccess } from "../self-protection";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function nativeAsk(message: string): void {
  process.stdout.write(JSON.stringify({
    permission: "ask",
    user_message: message,
    agent_message: message,
  }));
}

function deny(message: string): void {
  process.stdout.write(JSON.stringify({
    permission: "deny", continue: false,
    user_message: message, agent_message: message,
    userMessage: message, agentMessage: message,
  }));
}

async function main(): Promise<void> {
  let input: CursorHookInput;
  try {
    input = JSON.parse(await readStdin()) as CursorHookInput;
  } catch {
    nativeAsk("GrantTap could not read this shell call; use Cursor approval.");
    return;
  }
  const protectedAccess = protectedGrantTapAccess(
    input.tool_name, input.tool_input, input.command,
  );
  if (protectedAccess) {
    deny(protectedAccess.reason);
    return;
  }
  if (!isProviderEnabled("cursor")) {
    nativeAsk("GrantTap monitoring for Cursor is disabled; use Cursor approval.");
    return;
  }
  const rawSessionId = input.conversation_id ?? input.session_id;
  const sessionId = cursorRootSessionId(rawSessionId) ?? rawSessionId;
  const blocked = blockedSessionCapability(
    sessionId,
    input.tool_name ?? "Shell",
    input.tool_input ?? { command: input.command },
  );
  if (blocked) {
    deny(blocked.reason);
    return;
  }
  if (!sessionId || isGatingSkipped(sessionId)) {
    nativeAsk("GrantTap is paused or this shell call is unscoped; use Cursor approval.");
    return;
  }
  let config;
  try {
    config = loadConfig(machineConfigPath());
  } catch {
    nativeAsk("GrantTap is not paired; use Cursor approval.");
    return;
  }
  const request = cursorToRequest({
    ...input,
    conversation_id: sessionId,
    session_id: sessionId,
  });

  // Eligible levels approve locally — never wait on phone WS/APNs for an action
  // the configured level already allows.
  const level = autoAcceptLevelFor(sessionId);
  if (shouldAutoAcceptCursorShell(level, request.tool, request.command)) {
    process.stdout.write(JSON.stringify({ permission: "allow", continue: true }));
    return;
  }

  const timeoutMs = Number(process.env.GRANTTAP_APPROVAL_TIMEOUT_MS ?? 60_000);
  const decision = await requestApproval(config, request, { timeoutMs });
  if (isUnanswered(decision)) {
    nativeAsk("GrantTap got no answer; use Cursor approval.");
    return;
  }
  process.stdout.write(JSON.stringify(decisionToCursorOutput(decision)));
}

main().catch(() => {
  nativeAsk("GrantTap shell hook failed; use Cursor approval.");
  process.exit(0);
});
