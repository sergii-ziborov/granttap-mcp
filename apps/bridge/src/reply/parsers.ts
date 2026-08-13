import type { ReplyResult } from "./types";

export function parseCodexSchedulePlan(stdout: string): ReplyResult {
  let lastMessage = "";
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { item?: { type?: string; text?: string } };
      if (event.item?.type === "agent_message" && typeof event.item.text === "string") {
        lastMessage = event.item.text;
      }
    } catch {
      // Codex may emit diagnostics around the JSONL events.
    }
  }
  return lastMessage ? { ok: true, text: lastMessage } : { ok: false, error: "Codex returned no scheduler draft." };
}

export function parseClaudeSchedulePlan(stdout: string): ReplyResult {
  try {
    const parsed = JSON.parse(stdout) as { is_error?: boolean; result?: string; structured_output?: unknown };
    if (parsed.is_error) return { ok: false, error: parsed.result ?? "Claude planner error" };
    if (parsed.structured_output && typeof parsed.structured_output === "object") return { ok: true, text: JSON.stringify(parsed.structured_output) };
    if (typeof parsed.result === "string" && parsed.result.trim()) return { ok: true, text: parsed.result };
  } catch {
    // Planner output must be structured.
  }
  return { ok: false, error: "Claude returned no structured scheduler draft." };
}
