#!/usr/bin/env -S npx tsx
/** Cursor beforeShellExecution: exact chat block, otherwise phone/native approval. */
import { recordProjectDecision } from "../policy/decision-log";
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
import {
  evaluateEffectiveAction,
  legacyGrantTapFlowAllowed,
} from "../policy/effective-action";
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
  await handleShell(input);
}

async function handleShell(input: CursorHookInput): Promise<void> {
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
  const projectDecision = await evaluateEffectiveAction({
    provider: "cursor",
    sessionId,
    cwd: cursorCwd(input),
    toolName: input.tool_name ?? "Shell",
    toolInput: input.tool_input ?? { command: input.command },
    legacyDenyReason: blocked?.reason,
  });
  if (projectDecision.effect === "deny") {
    if (sessionId) {
      recordProjectDecision(sessionId, {
        at: Date.now(), toolName: input.tool_name ?? "Shell",
        reason: projectDecision.reason, ruleId: projectDecision.rule_id,
      });
    }
    deny(projectDecision.reason);
    return;
  }
  const legacyFlow = legacyGrantTapFlowAllowed(projectDecision);
  if (!sessionId) {
    if (!legacyFlow) deny("Project approval cannot be bound to an exact Cursor chat");
    else nativeAsk("GrantTap is paused or this shell call is unscoped; use Cursor approval.");
    return;
  }
  if (legacyFlow && isGatingSkipped(sessionId)) {
    nativeAsk("GrantTap is paused or this shell call is unscoped; use Cursor approval.");
    return;
  }
  await continueApproval(input, sessionId, legacyFlow);
}

async function continueApproval(
  input: CursorHookInput,
  sessionId: string,
  legacyFlow: boolean,
): Promise<void> {
  let config;
  try {
    config = loadConfig(machineConfigPath());
  } catch {
    if (!legacyFlow) deny("Project policy requires GrantTap approval, but this computer is not paired");
    else nativeAsk("GrantTap is not paired; use Cursor approval.");
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
  if (legacyFlow && shouldAutoAcceptCursorShell(level, request.tool, request.command)) {
    process.stdout.write(JSON.stringify({ permission: "allow", continue: true }));
    return;
  }

  const timeoutMs = Number(process.env.GRANTTAP_APPROVAL_TIMEOUT_MS ?? 60_000);
  let decision;
  try {
    decision = await requestApproval(config, request, { timeoutMs });
  } catch {
    if (!legacyFlow) deny("Project approval failed before a decision was recorded");
    else nativeAsk("GrantTap shell hook failed; use Cursor approval.");
    return;
  }
  if (isUnanswered(decision)) {
    if (!legacyFlow) deny("Project approval was required but no decision was received");
    else nativeAsk("GrantTap got no answer; use Cursor approval.");
    return;
  }
  process.stdout.write(JSON.stringify(decisionToCursorOutput(decision)));
}

function cursorCwd(input: CursorHookInput): string | undefined {
  if (typeof input.cwd === "string" && input.cwd.trim()) return input.cwd;
  return Array.isArray(input.workspace_roots) && typeof input.workspace_roots[0] === "string"
    ? input.workspace_roots[0]
    : undefined;
}

main().catch(() => {
  nativeAsk("GrantTap shell hook failed; use Cursor approval.");
  process.exit(0);
});
