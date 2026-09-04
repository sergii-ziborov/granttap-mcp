#!/usr/bin/env -S npx tsx
/** Cursor beforeMCPExecution: exact server/chat block, otherwise phone/native approval. */
import { recordProjectDecision } from "../policy/decision-log";
import { randomId } from "../../../../packages/core/crypto";
import type { ApprovalRequest } from "../../../../packages/protocol/schema";
import { decisionToCursorOutput } from "../adapters";
import { isUnanswered, requestApproval } from "../approval";
import {
  blockedSessionMcpServer,
  isGatingSkipped,
  isProviderEnabled,
  loadConfig,
  machineConfigPath,
  shouldAutoAcceptTool,
} from "../config";
import {
  cursorConversationId,
  resolveCursorMcpCapability,
  type CursorMcpHookInput,
} from "../cursor-mcp-policy";
import { recordAttributedCall } from "../mesh/call-scope";
import { mcpCapabilityFingerprint } from "../policy/capability-fingerprint";
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
  let input: CursorMcpHookInput;
  try {
    input = JSON.parse(await readStdin()) as CursorMcpHookInput;
  } catch {
    nativeAsk("GrantTap could not correlate this MCP call; use Cursor approval.");
    return;
  }
  await handleMcp(input);
}

async function handleMcp(input: CursorMcpHookInput): Promise<void> {
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
  const rawSessionId = cursorConversationId(input);
  const sessionId = cursorRootSessionId(rawSessionId) ?? rawSessionId;
  // See claude-hook.ts: Mesh events are published only for the calling session.
  recordAttributedCall({
    provider: "cursor",
    sessionId,
    toolName: input.tool_name,
    args: input.tool_input,
  });
  const capability = resolveCursorMcpCapability(input);
  const server = capability.server;
  const blocked = blockedSessionMcpServer(sessionId, server);
  const toolName = boundedToolName(input.tool_name);
  const projectDecision = await evaluateEffectiveAction({
    provider: "cursor",
    sessionId: sessionId ?? undefined,
    cwd: cursorWorkspaceRoot(input),
    toolName: server ? `mcp__${server}__${toolName}` : toolName,
    capability: mcpCapabilityFingerprint("cursor", {
      serverName: server,
      transport: capability.transport,
      configHash: capability.configHash,
    }),
    legacyDenyReason: blocked?.reason,
  });
  if (projectDecision.effect === "deny") {
    if (sessionId) {
      recordProjectDecision(sessionId, {
        at: Date.now(), toolName: server ? `mcp__${server}__${toolName}` : toolName,
        reason: projectDecision.reason, ruleId: projectDecision.rule_id,
      });
    }
    deny(projectDecision.reason);
    return;
  }
  const legacyFlow = legacyGrantTapFlowAllowed(projectDecision);
  if (!sessionId) {
    if (!legacyFlow) deny("Project approval cannot be bound to an exact Cursor chat");
    else nativeAsk("GrantTap is paused or this MCP call is unscoped; use Cursor approval.");
    return;
  }
  if (legacyFlow && isGatingSkipped(sessionId)) {
    nativeAsk("GrantTap is paused or this MCP call is unscoped; use Cursor approval.");
    return;
  }
  await continueApproval(input, sessionId, server, toolName, legacyFlow);
}

async function continueApproval(
  input: CursorMcpHookInput,
  sessionId: string,
  server: string | null,
  toolName: string,
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
  const identity = server ? `${server}/${toolName}` : toolName;
  const request = approvalRequest(input, sessionId, server, toolName, identity);
  // Eligible levels approve locally — an MCP call must not hang on a sleeping phone.
  if (legacyFlow && shouldAutoAcceptTool(sessionId, request.tool, request.command)) {
    process.stdout.write(JSON.stringify({ permission: "allow", continue: true }));
    return;
  }

  const timeoutMs = Number(process.env.GRANTTAP_APPROVAL_TIMEOUT_MS ?? 60_000);
  let decision;
  try {
    decision = await requestApproval(config, request, { timeoutMs });
  } catch {
    if (!legacyFlow) deny("Project approval failed before a decision was recorded");
    else nativeAsk("GrantTap MCP hook failed; use Cursor approval.");
    return;
  }
  if (isUnanswered(decision)) {
    if (!legacyFlow) deny("Project approval was required but no decision was received");
    else nativeAsk("GrantTap got no answer; use Cursor approval.");
    return;
  }
  process.stdout.write(JSON.stringify(decisionToCursorOutput(decision)));
}

function approvalRequest(
  input: CursorMcpHookInput,
  sessionId: string,
  server: string | null,
  toolName: string,
  identity: string,
): ApprovalRequest {
  return {
    type: "approval.request", requestId: randomId(6), agent: "cursor", kind: "permission",
    tool: server ? `mcp__${server}__${toolName}`.slice(0, 240) : toolName,
    title: `MCP · ${identity}`.slice(0, 180),
    // Never forward unredacted tool arguments; they may contain credentials.
    command: identity.slice(0, 240),
    cwd: cursorWorkspaceRoot(input)?.slice(0, 4096),
    sessionId, risk: "medium", createdAt: Date.now(),
  };
}

function boundedToolName(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "MCP tool";
  return (raw || "MCP tool").slice(0, 160);
}

function cursorWorkspaceRoot(input: CursorMcpHookInput): string | undefined {
  if (typeof input.cwd === "string" && input.cwd.trim()) return input.cwd;
  return Array.isArray(input.workspace_roots) && typeof input.workspace_roots[0] === "string"
    ? input.workspace_roots[0]
    : undefined;
}

main().catch(() => {
  nativeAsk("GrantTap MCP hook failed; use Cursor approval.");
  process.exit(0);
});
