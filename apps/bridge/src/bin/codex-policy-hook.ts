#!/usr/bin/env -S npx tsx
/** Codex PreToolUse: deterministic deny or one-shot Project ASK handoff. */
import { recordProjectDecision } from "../policy/decision-log";
import type { HookInput } from "../adapters";
import { blockedSessionCapability, isProviderEnabled } from "../config";
import { recordCodexProjectAsk } from "../policy/codex-project-ask";
import { evaluateEffectiveAction } from "../policy/effective-action";
import { protectedGrantTapAccess } from "../self-protection";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  let input: HookInput;
  try {
    input = JSON.parse(await readStdin()) as HookInput;
  } catch {
    return;
  }
  const protectedAccess = protectedGrantTapAccess(input.tool_name, input.tool_input);
  if (protectedAccess) {
    deny(protectedAccess.reason);
    return;
  }
  if (!isProviderEnabled("codex")) return;
  const blocked = blockedSessionCapability(
    input.session_id,
    input.tool_name,
    input.tool_input,
  );
  const decision = await evaluateEffectiveAction({
    provider: "codex",
    sessionId: input.session_id,
    cwd: input.cwd,
    toolName: input.tool_name,
    toolInput: input.tool_input,
    legacyDenyReason: blocked?.reason,
  });
  if (decision.effect === "deny") {
    if (input.session_id) {
      recordProjectDecision(input.session_id, {
        at: Date.now(), toolName: input.tool_name ?? "tool", reason: decision.reason, ruleId: decision.rule_id,
      });
    }
    deny(decision.reason);
    return;
  }
  if (decision.effect !== "ask") return;
  const recorded = recordCodexProjectAsk({
    sessionId: input.session_id,
    toolUseId: input.tool_use_id,
    toolName: input.tool_name,
    toolInput: input.tool_input,
  }, decision.reason);
  if (!recorded) {
    deny("Project approval could not be bound to this exact Codex call");
  }
}

function deny(reason: string): void {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }));
}

main().catch(() => {
  // An unexpected policy infrastructure failure must not lock Codex. Exact
  // configured blocks are enforced whenever config/input can be read.
  process.exit(0);
});
