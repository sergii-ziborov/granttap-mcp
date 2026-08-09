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
import { requestApproval } from "../approval";
import {
  blockedSessionCapability,
  isGatingSkipped,
  loadConfig,
  machineConfigPath,
} from "../config";

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

  const blocked = blockedSessionCapability(
    input.session_id,
    input.tool_name,
    input.tool_input,
  );
  if (blocked) {
    process.stdout.write(denyOutput(blocked.reason));
    return;
  }

  // Gating paused or this session exempt → stay silent (Codex uses its own flow).
  if (isGatingSkipped(input.session_id)) return;

  let cfg;
  try {
    cfg = loadConfig(machineConfigPath());
  } catch {
    process.stdout.write(denyOutput("GrantTap not paired (run `npm run init`)"));
    return;
  }

  const req = codexToRequest(input);
  const timeoutMs = Number(
    process.env.GRANTTAP_APPROVAL_TIMEOUT_MS ??
      process.env.NODVOX_APPROVAL_TIMEOUT_MS ??
      60_000,
  );
  const decision = await requestApproval(cfg, req, { timeoutMs });

  // Relay down: stay silent — an empty hook result sends Codex back to its own
  // approval flow, so desk work keeps going.
  if (decision.decision === "deny" && decision.decidedBy === "unreachable") return;

  process.stdout.write(JSON.stringify(decisionToCodexOutput(decision)));
}

main().catch((err) => {
  process.stdout.write(denyOutput(`GrantTap hook error: ${(err as Error).message}`));
  process.exit(0);
});
