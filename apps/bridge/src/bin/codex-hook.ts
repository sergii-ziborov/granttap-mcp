#!/usr/bin/env -S npx tsx
/**
 * Codex PermissionRequest hook entry point.
 *
 * Requires `[features] hooks = true` in ~/.codex/config.toml. Registered as a
 * PermissionRequest hook (the only Codex hook that can return BOTH allow and
 * deny). Same job as the Claude hook: forward the tool call to your phone,
 * print the decision Codex expects.
 *
 *   Reads:  PermissionRequest JSON on stdin
 *   Writes: { hookSpecificOutput: { decision: { behavior, message? } } } on stdout
 *
 * Fails closed on error/timeout.
 */
import { codexToRequest, decisionToCodexOutput, type HookInput } from "../adapters";
import { isUnanswered, requestApproval } from "../approval";
import {
  autoAcceptLevelFor,
  blockedSessionCapability,
  isGatingSkipped,
  isProviderEnabled,
  loadConfig,
  machineConfigPath,
  shouldAutoAcceptTool,
} from "../config";
import { recordAttributedCall } from "../mesh/call-scope";
import { classifyAction } from "../policy";
import { consumeCodexProjectAsk } from "../policy/codex-project-ask";
import { protectedGrantTapAccess } from "../self-protection";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function denyOutput(message: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message },
    },
  });
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let input: HookInput = {};
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    process.stdout.write(denyOutput("GrantTap received invalid hook JSON"));
    return;
  }

  const protectedAccess = protectedGrantTapAccess(input.tool_name, input.tool_input);
  if (protectedAccess) {
    process.stdout.write(denyOutput(protectedAccess.reason));
    return;
  }

  if (!isProviderEnabled("codex")) return;

  // See claude-hook.ts: the MCP server trusts this attribution, never the model.
  recordAttributedCall({
    provider: "codex",
    sessionId: input.session_id,
    toolName: input.tool_name,
    args: input.tool_input,
  });

  const blocked = blockedSessionCapability(
    input.session_id,
    input.tool_name,
    input.tool_input,
  );
  if (blocked) {
    process.stdout.write(denyOutput(blocked.reason));
    return;
  }
  const projectAsk = consumeCodexProjectAsk({
    sessionId: input.session_id,
    toolUseId: input.tool_use_id,
    toolName: input.tool_name,
    toolInput: input.tool_input,
  });

  // Gating paused or this session exempt → stay silent (Codex uses its own flow).
  if (!projectAsk && isGatingSkipped(input.session_id)) return;

  let cfg;
  try {
    cfg = loadConfig(machineConfigPath());
  } catch {
    process.stdout.write(denyOutput("GrantTap not paired (run `npm run init`)"));
    return;
  }

  // Local policy, evaluated after pairing is confirmed — see claude-hook.
  const req = codexToRequest(input);
  if (!projectAsk && shouldAutoAcceptTool(input.session_id, req.tool, req.command)) {
    const level = autoAcceptLevelFor(input.session_id);
    const cls = classifyAction(req.tool, req.command);
    process.stdout.write(
      JSON.stringify(
        decisionToCodexOutput({
          type: "approval.decision",
          requestId: req.requestId,
          decision: "allow",
          decidedBy: "auto",
          note: `GrantTap auto-accept (${level} / ${cls})`,
          decidedAt: Date.now(),
        }),
      ),
    );
    return;
  }

  const timeoutMs = Number(
    process.env.GRANTTAP_APPROVAL_TIMEOUT_MS ??
      process.env.NODVOX_APPROVAL_TIMEOUT_MS ??
      60_000,
  );
  const decision = await requestApproval(cfg, req, { timeoutMs });

  // Routine relay failure stays in Codex's native flow. A Project ASK cannot
  // fall through to provider approval because that would weaken the parent rule.
  if (isUnanswered(decision)) {
    if (projectAsk) {
      process.stdout.write(denyOutput("Project approval was required but no decision was received"));
    }
    return;
  }

  process.stdout.write(JSON.stringify(decisionToCodexOutput(decision)));
}

main().catch((err) => {
  process.stdout.write(denyOutput(`GrantTap hook error: ${(err as Error).message}`));
  process.exit(0);
});
