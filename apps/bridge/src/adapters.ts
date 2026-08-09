/**
 * Agent adapters — translate each agent's native permission format into our
 * neutral ApprovalRequest, and translate our ApprovalDecision back into the
 * shape that agent expects. The phone UI never learns which agent it approves.
 *
 * Both are wired end to end. The stdin payloads are nearly identical across
 * Claude Code and Codex (tool_name / tool_input / cwd / session_id), so one
 * mapper feeds both; only the ids and the stdout contract differ.
 *
 * Claude Code  — PreToolUse hook. stdout: hookSpecificOutput.permissionDecision
 *                = "allow" | "deny" | "ask".  (docs: code.claude.com/docs/en/hooks)
 * Codex        — requires `[features] hooks = true`, then the PermissionRequest
 *                hook, the only one that can return BOTH allow and deny. stdout:
 *                hookSpecificOutput.decision = { behavior: "allow" | "deny", message? }.
 *                (Codex PreToolUse can only deny and only wraps `shell`.)
 */
import type { ApprovalDecision, ApprovalRequest, Risk } from "../../../packages/protocol/schema";
import { randomId } from "../../../packages/core/crypto";

/** Heuristic risk tag so the watch can color/rank the request at a glance. */
export function guessRisk(tool: string, command: string | undefined): Risk {
  const c = (command ?? "").toLowerCase();
  const HIGH = [
    /\brm\s+-rf?\b/,
    /\bsudo\b/,
    /\bgit\s+push\b.*--force/,
    /\bgit\s+reset\s+--hard\b/,
    /\bcurl\b[^|]*\|\s*(sh|bash)\b/,
    /\bnpm\s+publish\b/,
    /\bdd\s+if=/,
    /\b(drop|truncate)\s+table\b/,
    /:\s*>\s*\//, // truncate a file
    /\bchmod\s+-r\b/,
  ];
  if (HIGH.some((re) => re.test(c))) return "high";
  const READONLY = ["Read", "Glob", "Grep", "NotebookRead", "WebFetch", "WebSearch"];
  if (READONLY.includes(tool)) return "low";
  return "medium";
}

/** Fields shared by the Claude and Codex hook stdin payloads. */
export type HookInput = {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  hook_event_name?: string;
  permission_mode?: string;
  transcript_path?: string;
};

function extractCommand(tool: string, ti: Record<string, unknown>): string {
  const cmd = ti["command"];
  if (typeof cmd === "string") return cmd;
  if (Array.isArray(cmd)) return cmd.map(String).join(" "); // Codex shell: string[]
  const path = ti["file_path"] ?? ti["path"] ?? ti["notebook_path"];
  if (typeof path === "string") return `${tool} ${path}`;
  const url = ti["url"];
  if (typeof url === "string") return `${tool} ${url}`;
  return tool;
}

function toRequest(agent: string, input: HookInput, idHint?: string): ApprovalRequest {
  const tool = input.tool_name ?? "tool";
  const command = extractCommand(tool, input.tool_input ?? {});
  return {
    type: "approval.request",
    requestId: idHint ?? randomId(6),
    agent,
    kind: "permission",
    tool,
    title: shortTitle(tool, command),
    command,
    cwd: input.cwd,
    sessionId: input.session_id,
    risk: guessRisk(tool, command),
    createdAt: Date.now(),
  };
}

// ---------------------------------------------------------------- Claude Code

export const claudeToRequest = (input: HookInput): ApprovalRequest => toRequest("claude", input);

export function decisionToClaudeOutput(d: ApprovalDecision): unknown {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: d.decision === "allow" ? "allow" : "deny",
      permissionDecisionReason:
        d.note ??
        (d.decision === "allow" ? "Approved from GrantTap" : "Denied from GrantTap"),
    },
  };
}

// --------------------------------------------------------------------- Codex

export const codexToRequest = (input: HookInput): ApprovalRequest =>
  toRequest("codex", input, input.tool_use_id);

export function decisionToCodexOutput(d: ApprovalDecision): unknown {
  const decision =
    d.decision === "allow"
      ? { behavior: "allow" }
      : { behavior: "deny", message: d.note ?? "Denied from GrantTap" };
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision,
    },
  };
}

// --------------------------------------------------------------------- Cursor

export type CursorHookInput = {
  conversation_id?: string;
  generation_id?: string;
  command?: string;
  cwd?: string;
  hook_event_name?: string;
  workspace_roots?: string[];
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
};

export function cursorToRequest(input: CursorHookInput): ApprovalRequest {
  const command = typeof input.command === "string" && input.command.trim()
    ? input.command
    : extractCommand("Shell", input.tool_input ?? {});
  const sessionId = input.conversation_id ?? input.session_id;
  const cwd = (typeof input.cwd === "string" && input.cwd.trim() ? input.cwd : undefined)
    ?? (Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : undefined);
  return {
    type: "approval.request",
    requestId: randomId(6),
    agent: "cursor",
    kind: "permission",
    tool: input.tool_name ?? "Shell",
    title: shortTitle("Shell", command),
    command,
    cwd,
    sessionId,
    risk: guessRisk("Shell", command),
    createdAt: Date.now(),
  };
}

export function decisionToCursorOutput(d: ApprovalDecision): unknown {
  const permission = d.decision === "allow" ? "allow" : "deny";
  const message = d.note
    ?? (d.decision === "allow" ? "Approved from GrantTap" : "Denied from GrantTap");
  return {
    permission,
    continue: d.decision === "allow",
    user_message: message,
    agent_message: message,
    userMessage: message,
    agentMessage: message,
  };
}

// ------------------------------------------------------------------ helpers

function shortTitle(tool: string, command: string): string {
  if (command) {
    const oneLine = command.replace(/\s+/g, " ").trim();
    return oneLine.length > 80 ? oneLine.slice(0, 77) + "…" : oneLine;
  }
  return tool;
}
