import type { ActivityEntry, SessionInfo } from "../../../../../packages/protocol/schema";
import { classifyCall, modelName } from "../classification/tools";
import { CallBook, type CallStatus, type Observation } from "./shared";

/** The newest rows read; a chat's map shows its recent work, not its whole history. */
const WINDOW = 400;

/** What a call's summary names after its tool (`Bash: npm test`), read only to choose a station. */
function detailOf(entry: ActivityEntry): string {
  if (entry.callText) return entry.callText;
  const prefix = `${entry.toolName ?? ""}: `;
  return entry.toolName && entry.text.startsWith(prefix) ? entry.text.slice(prefix.length) : "";
}

function statusOf(entry: ActivityEntry, pending: boolean): CallStatus {
  if (entry.outcome === "error") return "error";
  if (entry.outcome === "cancelled") return "blocked";
  if (entry.outcome === "success" || entry.durationMs !== undefined) return "ok";
  return pending ? "run" : "ok";
}

/**
 * Cursor and Grok Build, from the rows GrantTap already reads for the chat. Cursor says when a
 * call finishes, so a call without an outcome is still running; Grok's records do not, so its
 * calls are shown as done when they appear.
 */
export function entriesObservation(session: Pick<SessionInfo, "agent" | "model">, entries: ActivityEntry[]): Observation {
  const book = new CallBook();
  const pending = session.agent === "cursor";
  for (const entry of entries.slice(-WINDOW)) {
    const at = entry.createdAt;
    const agentKey = entry.childThreadId;
    const extra = agentKey ? { agentKey } : {};
    if (entry.kind === "tool") {
      const { station, name } = classifyCall(entry.toolName ?? "tool", detailOf(entry));
      const status = statusOf(entry, pending);
      const endedAt = entry.durationMs !== undefined ? at + entry.durationMs : status === "run" ? undefined : at;
      book.add({ key: entry.id, station, name, startedAt: at, status, ...(endedAt ? { endedAt } : {}), ...extra });
    } else if (entry.kind === "user" && !agentKey) book.mark(entry.id, "you", "message", at, "message");
    else if (entry.kind === "final" && !agentKey) book.mark(entry.id, "you", "answer", at, "answer");
    else if (entry.kind === "message") book.mark(`step:${entry.id}`, "model", "model step", at, "step", extra);
  }
  return book.observation({ model: modelName(session.model) });
}
