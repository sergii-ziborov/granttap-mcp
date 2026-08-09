#!/usr/bin/env -S npx tsx
/** Cursor beforeShellExecution: exact chat block, otherwise phone/native approval. */
import {
  cursorToRequest,
  decisionToCursorOutput,
  type CursorHookInput,
} from "../adapters";
import { requestApproval } from "../approval";
import {
  blockedSessionCapability,
  isGatingSkipped,
  loadConfig,
  machineConfigPath,
} from "../config";
import { cursorRootSessionId } from "../sessions/cursor";

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

async function main(): Promise<void> {
  let input: CursorHookInput;
  try {
    input = JSON.parse(await readStdin()) as CursorHookInput;
  } catch {
    nativeAsk("GrantTap could not read this shell call; use Cursor approval.");
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
    process.stdout.write(JSON.stringify({
      permission: "deny",
      continue: false,
      user_message: blocked.reason,
      agent_message: blocked.reason,
      userMessage: blocked.reason,
      agentMessage: blocked.reason,
    }));
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
  const timeoutMs = Number(process.env.GRANTTAP_APPROVAL_TIMEOUT_MS ?? 60_000);
  const decision = await requestApproval(config, request, { timeoutMs });
  if (decision.decision === "deny" && decision.decidedBy === "unreachable") {
    nativeAsk("GrantTap is unreachable; use Cursor approval.");
    return;
  }
  process.stdout.write(JSON.stringify(decisionToCursorOutput(decision)));
}

main().catch(() => {
  nativeAsk("GrantTap shell hook failed; use Cursor approval.");
  process.exit(0);
});
