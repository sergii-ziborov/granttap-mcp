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
 * through unattended.
 */
import { claudeToRequest, decisionToClaudeOutput, type HookInput } from "../adapters";
import { requestApproval } from "../approval";
import { isGatingSkipped, loadConfig, machineConfigPath } from "../config";

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

  const req = claudeToRequest(input);
  const timeoutMs = Number(
    process.env.GRANTTAP_APPROVAL_TIMEOUT_MS ??
      process.env.NODVOX_APPROVAL_TIMEOUT_MS ??
      60_000,
  );
  const decision = await requestApproval(cfg, req, { timeoutMs });

  // Relay down ≠ phone said no: hand the question back to the local prompt.
  if (decision.decision === "deny" && decision.decidedBy === "unreachable") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: "GrantTap relay недоступен — решай локально",
        },
      }),
    );
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
