/**
 * What a background run did in a chat, written down where the chat can read it.
 *
 * A message from the phone is answered by a fresh `claude -p --resume` of the
 * same chat. Its turns land in the transcript, but a live session holding that
 * chat open never sees them — its context was built before they happened — and
 * the phone sees only the closing words. Each run is therefore journaled: what
 * was asked, what came back, which files were written, how many tool calls it
 * took, and whether the run was cut off. A live session receives the unread
 * entries on its next prompt; the Mesh carries the same digest for the Task.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../config/paths";

export type RunRecord = {
  /** When the run started and finished, epoch ms. */
  at: number;
  endedAt: number;
  source: "phone";
  /** The words the person sent, without the attachment note; bounded. */
  prompt: string;
  ok: boolean;
  /** The closing words of the run, or why it failed; bounded. */
  outcome: string;
  /** Files the run wrote, relative to the workspace where known; bounded. */
  files: string[];
  /** Tool calls the run made. */
  tools: number;
  /** The run hit the delivery timeout and was stopped mid-work. */
  cutOff?: boolean;
  /** When a live session was told about this run. */
  deliveredAt?: number;
};

export const MAX_JOURNAL_RECORDS = 50;
export const MAX_PROMPT_CHARS = 200;
export const MAX_OUTCOME_CHARS = 600;
export const MAX_FILES = 24;

function journalPath(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return join(configDir(), "journal", `${safe}.jsonl`);
}

export function compactText(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function write(path: string, records: RunRecord[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), { mode: 0o600 });
  renameSync(temporary, path);
}

/** Every run journaled for a chat, oldest first. Unreadable lines are skipped. */
export function runJournal(sessionId: string): RunRecord[] {
  try {
    return readFileSync(journalPath(sessionId), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const record = JSON.parse(line) as RunRecord;
          return typeof record.at === "number" && typeof record.prompt === "string" ? [record] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function recordRun(sessionId: string, record: RunRecord): void {
  try {
    const bounded: RunRecord = {
      ...record,
      prompt: compactText(record.prompt, MAX_PROMPT_CHARS),
      outcome: compactText(record.outcome, MAX_OUTCOME_CHARS),
      files: record.files.slice(0, MAX_FILES),
    };
    write(journalPath(sessionId), [...runJournal(sessionId), bounded].slice(-MAX_JOURNAL_RECORDS));
  } catch {
    // A journal that cannot be written costs nothing else: the reply still goes out.
  }
}

/** Runs a live session has not been told about yet. */
export function unreadRuns(sessionId: string): RunRecord[] {
  return runJournal(sessionId).filter((record) => record.deliveredAt == null);
}

export function markRunsDelivered(sessionId: string, at: number): void {
  try {
    const records = runJournal(sessionId);
    if (!records.some((record) => record.deliveredAt == null)) return;
    write(journalPath(sessionId), records.map((record) =>
      record.deliveredAt == null ? { ...record, deliveredAt: at } : record));
  } catch {
    // Left unread, it is shown again next time; never worse than that.
  }
}

/** One line a person or a model can read: what was asked, what happened, what it touched. */
export function describeRun(record: RunRecord): string {
  const parts = [`«${record.prompt}» → ${record.ok ? "" : "failed: "}${record.outcome}`];
  if (record.files.length > 0) {
    const shown = record.files.slice(0, 6).join(", ");
    const more = record.files.length > 6 ? ` (+${record.files.length - 6})` : "";
    parts.push(`wrote ${shown}${more}`);
  }
  if (record.tools > 0) parts.push(`${record.tools} tool call${record.tools === 1 ? "" : "s"}`);
  if (record.cutOff) {
    const seconds = Math.max(1, Math.round((record.endedAt - record.at) / 1000));
    parts.push(`cut off after ${seconds}s — its work may be unfinished and uncommitted`);
  }
  return parts.join("; ");
}
