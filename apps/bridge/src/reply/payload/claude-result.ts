import { explainClaudeFailure, type ClaudeBinary } from "../../providers/claude-bin";
import type { ReplyResult } from "./types";

/**
 * What `claude -p --output-format json` printed. A new chat names itself in `session_id`, falling
 * back to the id it was started with; a resumed chat's answer is not cut short.
 */
export function parseClaudeResult(stdout: string, claude: ClaudeBinary, startedAs?: string): ReplyResult {
  try {
    const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean; session_id?: string };
    if (parsed.is_error) {
      return { ok: false, error: explainClaudeFailure(parsed.result ?? "agent error", claude) };
    }
    if (typeof parsed.result === "string") {
      return startedAs ? { ok: true, text: parsed.result.slice(0, 4000), sessionId: parsed.session_id ?? startedAs }
        : { ok: true, text: parsed.result };
    }
  } catch {
    // Fall through to the plain output fallback.
  }
  const trimmed = stdout.trim();
  return trimmed
    ? { ok: true, text: trimmed.slice(0, 4000) }
    : { ok: false, error: "Claude returned an empty response." };
}

/** Whether Claude printed its final answer: the one JSON object it writes when the turn ends. */
export function claudeFinished(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout) as { result?: unknown; is_error?: unknown };
    return typeof parsed.result === "string" || parsed.is_error === true;
  } catch { return false; }
}
