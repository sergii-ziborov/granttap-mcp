#!/usr/bin/env -S npx tsx
/**
 * Claude Code PreToolUse hook entry point.
 *
 * Registered in ~/.claude/settings.json so that before Claude runs a tool, this
 * program receives the tool call on stdin, forwards it to your phone for
 * approval, and prints the allow/deny decision Claude expects on stdout.
 *
 *   Reads:  PreToolUse JSON on stdin
 *   Writes: { hookSpecificOutput: { permissionDecision, ... } } on stdout
 *
 * Fails closed: any error or timeout denies the tool call rather than letting it
 * through unattended — unless GrantTap auto-accept allows it locally.
 */
import { recordProjectDecision } from "../policy/decision-log";
import { claudeToRequest, decisionToClaudeOutput, type HookInput } from "../adapters";
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
import {
  evaluateEffectiveAction,
  legacyGrantTapFlowAllowed,
} from "../policy/effective-action";
import { protectedGrantTapAccess } from "../self-protection";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    writePermission("deny", "GrantTap received invalid hook JSON");
    return;
  }
  await handlePreToolUse(input);
}

async function handlePreToolUse(input: HookInput): Promise<void> {
  const protectedAccess = protectedGrantTapAccess(input.tool_name, input.tool_input);
  if (protectedAccess) {
    writePermission("deny", protectedAccess.reason);
    return;
  }

  if (!isProviderEnabled("claude")) return;

  // Attribute this exact GrantTap call to the session that made it. The MCP
  // server cannot see the caller, so without this a model could publish Mesh
  // events in another execution's name.
  recordAttributedCall({
    provider: "claude",
    sessionId: input.session_id,
    toolName: input.tool_name,
    args: input.tool_input,
  });

  const blocked = blockedSessionCapability(
    input.session_id,
    input.tool_name,
    input.tool_input,
  );
  const projectDecision = await evaluateEffectiveAction({
    provider: "claude",
    sessionId: input.session_id,
    cwd: input.cwd,
    toolName: input.tool_name,
    toolInput: input.tool_input,
    legacyDenyReason: blocked?.reason,
  });
  if (projectDecision.effect === "deny") {
    // Say so where the action was, not only to the agent.
    if (input.session_id) {
      recordProjectDecision(input.session_id, {
        at: Date.now(), toolName: input.tool_name ?? "tool", reason: projectDecision.reason,
        ruleId: projectDecision.rule_id,
      });
    }
    writePermission("deny", projectDecision.reason);
    return;
  }
  const legacyFlow = legacyGrantTapFlowAllowed(projectDecision);

  // Claude already granted this chat unconditional tool access. GrantTap's
  // Project ASK/DENY is a parent boundary, so bypass mode cannot weaken it.
  if (legacyFlow && input.permission_mode === "bypassPermissions") return;

  // Gating paused, or this session is exempt → abstain (empty output = Claude
  // uses its normal permission flow, exactly as if GrantTap weren't installed).
  if (legacyFlow && isGatingSkipped(input.session_id)) return;
  await continuePermissionFlow(input, legacyFlow);
}

async function continuePermissionFlow(input: HookInput, legacyFlow: boolean): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig(machineConfigPath());
  } catch {
    if (!legacyFlow) {
      writePermission("deny", "Project policy requires GrantTap approval, but this computer is not paired");
      return;
    }
    // No pairing yet: don't block the user's normal workflow — defer to Claude's
    // own prompt by emitting "ask".
    writePermission("ask", "GrantTap not paired (run `npm run init`)");
    return;
  }

  // Local policy, evaluated after pairing is confirmed: an unpaired machine must
  // keep Claude's own prompts rather than be silently auto-allowed by a product
  // the user never finished setting up. Once paired, this is what keeps routine
  // work independent of whether the phone is awake, reachable, or even running.
  const req = claudeToRequest(input);
  if (legacyFlow && shouldAutoAcceptTool(input.session_id, req.tool, req.command)) {
    writeAutoApproval(input, req);
    return;
  }

  const timeoutMs = Number(
    process.env.GRANTTAP_APPROVAL_TIMEOUT_MS ??
      process.env.NODVOX_APPROVAL_TIMEOUT_MS ??
      60_000,
  );
  const decision = await requestApproval(cfg, req, { timeoutMs });

  // Relay down or phone asleep ≠ phone said no: abstain so Claude's local flow
  // handles it (avoid flooding "решай локально" on every tool).
  if (isUnanswered(decision)) {
    if (!legacyFlow) {
      writePermission("deny", "Project approval was required but no decision was received");
    }
    return;
  }

  process.stdout.write(JSON.stringify(decisionToClaudeOutput(decision)));
}

function writeAutoApproval(input: HookInput, req: ReturnType<typeof claudeToRequest>): void {
  const level = autoAcceptLevelFor(input.session_id);
  const cls = classifyAction(req.tool, req.command);
  process.stdout.write(JSON.stringify(decisionToClaudeOutput({
    type: "approval.decision",
    requestId: req.requestId,
    decision: "allow",
    decidedBy: "auto",
    note: `GrantTap auto-accept (${level} / ${cls})`,
    decidedAt: Date.now(),
  })));
}

function writePermission(decision: "deny" | "ask", reason: string): void {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
}

main().catch((err) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `GrantTap hook error: ${(err as Error).message}`,
      },
    }),
  );
  process.exit(0);
});
