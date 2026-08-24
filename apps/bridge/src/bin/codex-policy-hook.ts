#!/usr/bin/env -S npx tsx
/** Deny-only Codex PreToolUse policy for exact per-chat capability switches. */
import type { HookInput } from "../adapters";
import { blockedSessionCapability, isProviderEnabled } from "../config";
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
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: protectedAccess.reason,
      },
    }));
    return;
  }
  if (!isProviderEnabled("codex")) return;
  const blocked = blockedSessionCapability(
    input.session_id,
    input.tool_name,
    input.tool_input,
  );
  if (!blocked) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: blocked.reason,
    },
  }));
}

main().catch(() => {
  // An unexpected policy infrastructure failure must not lock Codex. Exact
  // configured blocks are enforced whenever config/input can be read.
  process.exit(0);
});
