/**
 * A run's answer read from its files, and sent through the continuation its delivery registered.
 *
 * A run's answer read from its files by a monitor that did not start it. The monitor that started a
 * run knows how its process exited; a later one may not, so without an exit status an answer counts
 * only when the provider reported the end of its turn, and a cut-off run is reported as such.
 */
import { claudeFinished, parseClaudeResult } from "../payload/claude-result";
import type { ReplyResult } from "../payload/types";
import { codexFinished, codexOwnerConflict, parseCodexJsonl } from "../process/codex-headless";
import { providerExitFailure } from "../process/auth-failure";
import { grokFinished, parseGrok } from "../grok-response";
import { resolveClaudeBinary } from "../../providers/claude-bin";
import { claudeLogPath } from "../../sessions/scan/claude/shared";
import { tailLines } from "../../live-map/readers/shared";
import { join } from "node:path";
import { runContinuation } from ".";
import { readRunOutput } from "./files";
import { removeRun, runFolder, runsRoot, takeRunRecord, type RunRecord } from "./records";

const NAMES: Record<RunRecord["parser"]["kind"], string> = {
  claude: "Claude Code", "claude-new": "Claude Code", codex: "Codex", grok: "Grok Build",
};

function parse(record: RunRecord, stdout: string): ReplyResult {
  const { kind, sessionId } = record.parser;
  if (kind === "codex") return codexOwnerConflict(parseCodexJsonl(stdout, sessionId));
  if (kind === "grok") return parseGrok(stdout, sessionId ?? "");
  return parseClaudeResult(stdout, resolveClaudeBinary(), kind === "claude-new" ? sessionId : undefined);
}

function finished(record: RunRecord, stdout: string): boolean {
  const { kind } = record.parser;
  return kind === "codex" ? codexFinished(stdout) : kind === "grok" ? grokFinished(stdout) : claudeFinished(stdout);
}

/** How much of a chat's transcript is read to see whether the run's turn ended. */
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

/**
 * Whether a Claude chat's own transcript shows a turn ended after the run started. `claude -p` prints
 * its answer only when the process exits; a run whose answer could not be written then (a full disk
 * on 24 November 2026) or whose exit no monitor saw had answered in the chat all the same.
 */
export function claudeTurnAnsweredSince(sessionId: string, since: number): boolean {
  const path = claudeLogPath(sessionId);
  const lines = path ? tailLines(path, TRANSCRIPT_TAIL_BYTES) ?? [] : [];
  return lines.some((line) => {
    let row: { isSidechain?: boolean; type?: string; timestamp?: string; message?: { stop_reason?: string } };
    try { row = JSON.parse(line); } catch { return false; }
    return row.isSidechain !== true && row.type === "assistant" && row.message?.stop_reason === "end_turn"
      && Date.parse(row.timestamp ?? "") >= since;
  });
}

/** A Claude run cut off without its answer, whose turn the chat shows answered: the answer is in the chat. */
function answeredInChat(record: RunRecord): ReplyResult | undefined {
  if (record.parser.kind !== "claude" && record.parser.kind !== "claude-new") return undefined;
  const sessionId = record.parser.sessionId ?? (record.key.startsWith("__new_") ? undefined : record.key);
  if (!sessionId || !claudeTurnAnsweredSince(sessionId, record.startedAt)) return undefined;
  return { ok: true, text: "", sessionId, delivery: "native" };
}

/** The answer of a run that has ended, from what it wrote. */
export function adoptedResult(record: RunRecord, output: { stdout: string; stderr: string }, timedOut: boolean): ReplyResult {
  if (timedOut) return { ok: false, error: `${record.command} did not respond within ${Math.round((record.deadline - record.startedAt) / 1000)}s.` };
  const exit = record.exit;
  if (exit && exit.code !== 0) {
    return { ok: false, error: providerExitFailure(record.command, output.stderr, output.stdout, exit.code) };
  }
  if (!exit && !finished(record, output.stdout)) {
    const answered = answeredInChat(record);
    if (answered) return answered;
    return { ok: false, error: `${NAMES[record.parser.kind]} stopped before it finished this turn, while GrantTap `
      + "was restarting. Its work so far is in the chat." };
  }
  try { return parse(record, output.stdout); }
  catch (error) { return { ok: false, error: `${record.command} returned an unreadable result: ${(error as Error).message}` }; }
}

/** What the run wrote to its files. */
export function runOutput(record: RunRecord, root = runsRoot()): { stdout: string; stderr: string } {
  const folder = runFolder(record.runId, root);
  return { stdout: readRunOutput(join(folder, "stdout")), stderr: readRunOutput(join(folder, "stderr")) };
}

/**
 * Take the run's record and send its answer through its continuation; then the folder goes. A
 * monitor that finds the record already taken leaves it to the one that took it.
 */
export async function deliverRun(record: RunRecord, result: ReplyResult, root = runsRoot()): Promise<boolean> {
  if (!takeRunRecord(record.runId, root)) return false;
  const settle = record.continuation ? runContinuation(record.continuation.kind) : undefined;
  try { if (settle) await settle(record.continuation!.data, result); }
  catch { /* Sent as far as it could be; the folder is not kept for a second attempt that could repeat it. */ }
  finally { removeRun(record.runId, root); }
  return true;
}
