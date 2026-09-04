import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../config/paths";

/**
 * What a Project rule refused, kept where the chat can show it.
 *
 * A hook answers the agent and exits; the agent sees "denied" and the person
 * sees nothing, or a retry they cannot explain. Each refusal is written down
 * for its chat so the transcript can carry a line that says which rule spoke
 * — the missing half of Governance, which until now could stop an action
 * without ever saying so where the action was.
 */
export type ProjectDecisionRecord = {
  at: number;
  toolName: string;
  reason: string;
  ruleId?: string;
};

const MAX_RECORDS = 50;

function logPath(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return join(configDir(), "decisions", `${safe}.jsonl`);
}

export function recordProjectDecision(sessionId: string, record: ProjectDecisionRecord): void {
  try {
    const path = logPath(sessionId);
    mkdirSync(join(configDir(), "decisions"), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    if (lines.length > MAX_RECORDS) {
      const trimmed = `${path}.tmp`;
      writeFileSync(trimmed, `${lines.slice(-MAX_RECORDS).join("\n")}\n`, { mode: 0o600 });
      renameSync(trimmed, path);
    }
  } catch {
    // A refusal that cannot be written down is still a refusal.
  }
}

export function recentProjectDecisions(sessionId: string): ProjectDecisionRecord[] {
  try {
    return readFileSync(logPath(sessionId), "utf8").split("\n").filter(Boolean).flatMap((line) => {
      try {
        const value = JSON.parse(line) as ProjectDecisionRecord;
        return typeof value.at === "number" && typeof value.reason === "string" ? [value] : [];
      } catch {
        return [];
      }
    }).slice(-MAX_RECORDS);
  } catch {
    return [];
  }
}
