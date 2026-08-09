#!/usr/bin/env -S npx tsx
/** Cursor afterShellExecution: retire the exact chat's orphaned phone card. */
import { RelayClient } from "../../../../packages/core/relay-client";
import {
  markApprovalTerminal,
  pendingApprovalRegistrations,
  resolvedFromOutcome,
  sendApprovalResolved,
} from "../approval-state";
import { loadConfig, machineConfigPath } from "../config";
import { cursorRootSessionId } from "../sessions/cursor";

const SHELL_TOOLS = new Set([
  "bash",
  "shell",
  "powershell",
  "terminal",
  "shell_command",
  "run_terminal_cmd",
]);

function isShellRequest(tool: string): boolean {
  const normalized = tool.trim().toLowerCase();
  const leaf = normalized.split(/[.:/]/).at(-1) ?? normalized;
  return SHELL_TOOLS.has(normalized) || SHELL_TOOLS.has(leaf);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const raw = await readStdin().catch(() => "");
  let input: {
    conversation_id?: string;
    session_id?: string;
    command?: string;
  } = {};
  try {
    input = JSON.parse(raw) as typeof input;
  } catch {
    // Older Cursor releases may omit the body. Never cancel an unscoped card.
  }
  const rawSessionId = input.conversation_id?.trim() || input.session_id?.trim() || null;
  const sessionId = cursorRootSessionId(rawSessionId) ?? rawSessionId;
  if (!sessionId) {
    process.stdout.write("{}\n");
    return;
  }

  const command = input.command?.trim();
  const cancelled = pendingApprovalRegistrations()
    .filter(({ request }) =>
      request.agent === "cursor"
        && request.sessionId === sessionId
        && isShellRequest(request.tool)
        && (!command || request.command?.trim() === command),
    )
    .map(({ request, handle }) => ({
      request,
      accepted: markApprovalTerminal(request.requestId, "cancelled", {
        decision: "allow",
        decidedBy: "cursor-local",
        note: "Cursor ran the shell command locally",
        sessionId,
      }, Date.now(), handle),
    }))
    .filter((item) => item.accepted.matched && item.accepted.outcome);

  if (cancelled.length > 0) {
    try {
      const client = new RelayClient(loadConfig(machineConfigPath()));
      await client.connect();
      try {
        for (const { request, accepted } of cancelled) {
          await sendApprovalResolved(
            client,
            resolvedFromOutcome(accepted.outcome!, request),
          );
        }
      } finally {
        client.close();
      }
    } catch {
      // Durable state is already cancelled; the monitor's next snapshot clears
      // the phone card even if this one-shot notification cannot reach relay.
    }
  }
  process.stdout.write("{}\n");
}

main().catch(() => {
  process.stdout.write("{}\n");
  process.exit(0);
});
