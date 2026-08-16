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
import { claudeToRequest, decisionToClaudeOutput, type HookInput } from "../adapters";
import { isUnanswered, requestApproval } from "../approval";
import {
  autoAcceptLevelFor,
  blockedSessionCapability,
  isGatingSkipped,
  loadConfig,
  machineConfigPath,
  shouldAutoAcceptTool,
} from "../config";
import { classifyAction } from "../policy";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let input: HookInput = {};
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "GrantTap received invalid hook JSON",
        },
      }),
    );
    return;
  }

  const blocked = blockedSessionCapability(
    input.session_id,
    input.tool_name,
    input.tool_input,
  );
  if (blocked) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: blocked.reason,
        },
      }),
    );
    return;
  }

  // Claude already granted this chat unconditional tool access. GrantTap's
  // explicit MCP/skill/CLI blocks above still win, but phone approval must not
  // re-prompt a call Claude is intentionally running in bypass mode.
  // TEMPORARY DIAGNOSTIC: record only permission-related metadata, never the
  // tool input or any prompt text. Remove once the bypass field name is known.
  try {
    const { appendFileSync } = await import("node:fs");
    appendFileSync("/tmp/granttap-hook-probe.log", JSON.stringify({
      keys: Object.keys(input),
      permission_mode: (input as Record<string, unknown>).permission_mode,
      permissionMode: (input as Record<string, unknown>).permissionMode,
      tool_name: (input as Record<string, unknown>).tool_name,
      session_id: String((input as Record<string, unknown>).session_id ?? "").slice(0, 8),
    }) + "\n");
  } catch { /* diagnostics must never block a tool call */ }

  if (input.permission_mode === "bypassPermissions") return;

  // Gating paused, or this session is exempt → abstain (empty output = Claude
  // uses its normal permission flow, exactly as if GrantTap weren't installed).
  if (isGatingSkipped(input.session_id)) return;

  let cfg;
  try {
    cfg = loadConfig(machineConfigPath());
  } catch {
    // No pairing yet: don't block the user's normal workflow — defer to Claude's
    // own prompt by emitting "ask".
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: "GrantTap not paired (run `npm run init`)",
        },
      }),
    );
    return;
  }

  // Local policy, evaluated after pairing is confirmed: an unpaired machine must
  // keep Claude's own prompts rather than be silently auto-allowed by a product
  // the user never finished setting up. Once paired, this is what keeps routine
  // work independent of whether the phone is awake, reachable, or even running.
  const req = claudeToRequest(input);
  if (shouldAutoAcceptTool(input.session_id, req.tool, req.command)) {
    const level = autoAcceptLevelFor(input.session_id);
    const cls = classifyAction(req.tool, req.command);
    process.stdout.write(
      JSON.stringify(
        decisionToClaudeOutput({
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

  // Relay down or phone asleep ≠ phone said no: abstain so Claude's local flow
  // handles it (avoid flooding "решай локально" on every tool).
  if (isUnanswered(decision)) {
    return;
  }

  process.stdout.write(JSON.stringify(decisionToClaudeOutput(decision)));
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
