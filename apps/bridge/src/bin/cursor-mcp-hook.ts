#!/usr/bin/env -S npx tsx
/** Cursor beforeMCPExecution: exact server/chat block, otherwise phone/native approval. */
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
  resolveCursorMcpServer,
  type CursorMcpHookInput,
} from "../cursor-mcp-policy";
import { recordAttributedCall } from "../mesh/call-scope";
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
  let input: CursorMcpHookInput;
  try {
    input = JSON.parse(await readStdin()) as CursorMcpHookInput;
  } catch {
    nativeAsk("GrantTap could not correlate this MCP call; use Cursor approval.");
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
  const server = resolveCursorMcpServer(input);
  const blocked = blockedSessionMcpServer(sessionId, server);
  if (blocked) {
    process.stdout.write(JSON.stringify({
      permission: "deny",
      user_message: blocked.reason,
      agent_message: blocked.reason,
    }));
    return;
  }
  if (!sessionId || isGatingSkipped(sessionId)) {
    nativeAsk("GrantTap is paused or this MCP call is unscoped; use Cursor approval.");
    return;
  }
  let config;
  try {
    config = loadConfig(machineConfigPath());
  } catch {
    nativeAsk("GrantTap is not paired; use Cursor approval.");
    return;
  }
  const rawTool = typeof input.tool_name === "string" ? input.tool_name.trim() : "MCP tool";
  const toolName = (rawTool || "MCP tool").slice(0, 160);
  const identity = server ? `${server}/${toolName}` : toolName;
  const request: ApprovalRequest = {
    type: "approval.request",
    requestId: randomId(6),
    agent: "cursor",
    kind: "permission",
    tool: server ? `mcp__${server}__${toolName}`.slice(0, 240) : toolName,
    title: `MCP · ${identity}`.slice(0, 180),
    // Never forward unredacted tool arguments; they may contain credentials.
    command: identity.slice(0, 240),
    cwd: Array.isArray(input.workspace_roots) && typeof input.workspace_roots[0] === "string"
      ? input.workspace_roots[0].slice(0, 4096)
      : undefined,
    sessionId,
    risk: "medium",
    createdAt: Date.now(),
  };
  // Eligible levels approve locally — an MCP call must not hang on a sleeping phone.
  if (shouldAutoAcceptTool(sessionId, request.tool, request.command)) {
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
  nativeAsk("GrantTap MCP hook failed; use Cursor approval.");
  process.exit(0);
});
