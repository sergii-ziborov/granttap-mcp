/**
 * GrantTap auto-accept policy (Layer B).
 *
 * Evaluated on the Mac hook while gating is on. The phone only configures
 * levels; the relay never sees tool/command plaintext for this decision.
 */
import { guessRisk } from "./adapters";

export type ActionClass =
  | "read"
  | "edit"
  | "bash"
  | "mcp"
  | "git_push"
  | "git_force"
  | "destructive"
  | "network_write";

export type AutoAcceptLevel =
  | "ask"
  | "safe"
  | "except_push"
  | "except_destructive"
  | "full";

export const AUTO_ACCEPT_LEVELS: AutoAcceptLevel[] = [
  "ask",
  "safe",
  "except_push",
  "except_destructive",
  "full",
];

export function isAutoAcceptLevel(value: unknown): value is AutoAcceptLevel {
  return typeof value === "string" && (AUTO_ACCEPT_LEVELS as string[]).includes(value);
}

/** Classify a tool call for auto-accept decisions. */
export function classifyAction(tool: string, command: string | null | undefined): ActionClass {
  const c = (command ?? "").toLowerCase();
  const t = tool;

  if (/^mcp__/i.test(t) || /^mcp\b/i.test(t)) return "mcp";

  if (/\bgit\s+push\b/.test(c) && /(--force|--force-with-lease|-f)\b/.test(c)) return "git_force";
  if (/\bgit\s+push\b/.test(c)) return "git_push";
  if (/\bgit\s+reset\s+--hard\b/.test(c)) return "git_force";

  if (
    /\brm\s+-rf?\b/.test(c) ||
    /\bsudo\b/.test(c) ||
    /\b(drop|truncate)\s+table\b/.test(c) ||
    /\bdd\s+if=/.test(c) ||
    /\bchmod\s+-r\b/.test(c) ||
    /:\s*>\s*\//.test(c)
  ) {
    return "destructive";
  }

  if (/\bnpm\s+publish\b/.test(c) || /\bcurl\b[^|]*\|\s*(sh|bash)\b/.test(c)) {
    return "network_write";
  }

  const READONLY = ["Read", "Glob", "Grep", "NotebookRead", "WebFetch", "WebSearch"];
  if (READONLY.includes(t)) return "read";

  const EDIT = ["Edit", "Write", "NotebookEdit", "MultiEdit"];
  if (EDIT.includes(t)) return "edit";

  // Fall back to risk heuristic for unknown tools.
  const risk = guessRisk(t, command ?? undefined);
  if (risk === "low") return "read";
  if (risk === "high") return "destructive";
  return "bash";
}

export function shouldAutoAllow(level: AutoAcceptLevel, cls: ActionClass): boolean {
  if (level === "ask") return false;
  if (level === "full") return true;
  if (level === "safe") return cls === "read";
  if (level === "except_push") {
    return !["git_push", "git_force", "destructive", "network_write"].includes(cls);
  }
  // except_destructive — plain push may auto; force/destructive/network still ask
  return !["git_force", "destructive", "network_write"].includes(cls);
}

/**
 * Narrow allowlist used for anti-thrash under `safe` (rg/ls/git status).
 * Does not require the iOS app — evaluated only on the Mac hook.
 */
export function isSafeReadonlyShell(command: string | null | undefined): boolean {
  const raw = (command ?? "").trim();
  if (!raw || raw.length > 500) return false;
  if (/[\n\r]/.test(raw)) return false;
  if (/[|&;><`]|\$\(|\bsudo\b|\bcurl\b|\bwget\b|\bnpm\b|\byarn\b|\bpnpm\b|\bxcodebuild\b|\bgit\s+push\b|\brm\b|\bmv\b|\bcp\b|\bchmod\b|\bchown\b/i.test(raw)) {
    return false;
  }
  const parts = raw.split(/\s+/);
  const bin = (parts[0] ?? "").replace(/^.*\//, "");
  if (bin === "git") {
    const sub = parts[1] ?? "";
    return ["status", "diff", "log", "show", "branch", "rev-parse"].includes(sub);
  }
  return [
    "rg",
    "grep",
    "ls",
    "pwd",
    "head",
    "tail",
    "wc",
    "true",
    "false",
    "date",
    "uname",
    "whoami",
    "which",
    "type",
    "echo",
    "cat",
    "find",
  ].includes(bin);
}

/**
 * Auto-accept for Cursor beforeShellExecution.
 *
 * Policy is Mac-local (`~/.granttap/config.json`). Eligible gates must approve
 * even when the GrantTap iOS app is fully closed — never wait on phone WS/APNs
 * for a level that already allows the action.
 *
 * Ask-always / denied classes still dual-channel to phone + Cursor chat.
 * Cursor may still show a separate native sandbox Allow for `required_permissions:
 * ["all"]`; that is not a GrantTap phone dependency.
 */
export function shouldAutoAcceptCursorShell(
  level: AutoAcceptLevel,
  tool: string,
  command: string | null | undefined,
): boolean {
  if (level === "ask") return false;
  if (level === "full") return true;
  const cls = classifyAction(tool, command);
  if (shouldAutoAllow(level, cls)) return true;
  // `safe` classifies many readonly bins as bash — still skip the phone.
  return level === "safe" && isSafeReadonlyShell(command);
}

export function resolveAutoAcceptLevel(opts: {
  paused?: boolean;
  defaultLevel?: AutoAcceptLevel;
  bySession?: Record<string, AutoAcceptLevel>;
  sessionId?: string;
}): AutoAcceptLevel {
  if (opts.paused) return "ask";
  const sid = opts.sessionId;
  if (sid && opts.bySession?.[sid]) return opts.bySession[sid]!;
  return opts.defaultLevel ?? "except_push";
}
