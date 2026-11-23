import type { SessionInfo } from '../../../../packages/protocol/schema';
import { explainClaudeFailure, resolveClaudeBinary } from '../providers/claude-bin';
import { runProcess } from '../reply/process';

/** `refused`: it did not run, because the chat was not between turns; the words say why. */
export type CompactOutcome = { ok: true; preTokens?: number; postTokens?: number } | { ok: false; error: string; refused?: boolean };

/** Summarising a context near a million tokens streams a long summary; a turn's own deadline is too short. */
export const CLAUDE_COMPACT_TIMEOUT_MS = 15 * 60_000;

const tokens = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function rowText(content: unknown): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((block: any) => typeof block?.text === 'string' ? block.text : '').join('') : '';
}

function short(text: unknown): string | undefined {
  const value = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return value ? value.slice(0, 300) : undefined;
}

/**
 * What `claude -p --resume <id> --output-format stream-json --verbose /compact` printed. Claude
 * Code reports the compaction itself (`compact_boundary`, with the context before and after); a
 * refusal comes as a failed compaction status, the command's own output or an error result.
 */
export function readClaudeCompaction(stdout: string): CompactOutcome {
  let boundary: any, failed: string | undefined, said: string | undefined, result: any;
  for (const line of stdout.split('\n')) {
    let row: any;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.type === 'system' && row.subtype === 'compact_boundary') boundary = row.compact_metadata ?? {};
    else if (row?.type === 'system' && row.subtype === 'status' && row.compact_result === 'failed') {
      failed = short(row.compact_error) ?? 'Claude Code could not compact the conversation.';
    } else if (row?.type === 'user') {
      said = short(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(rowText(row.message?.content))?.[1]) ?? said;
    } else if (row?.type === 'result') result = row;
  }
  if (boundary) {
    const preTokens = tokens(boundary.pre_tokens), postTokens = tokens(boundary.post_tokens);
    return { ok: true, ...(preTokens != null ? { preTokens } : {}), ...(postTokens != null ? { postTokens } : {}) };
  }
  if (failed) return { ok: false, error: failed };
  if (result?.is_error) {
    return { ok: false, error: short(Array.isArray(result.errors) ? result.errors.join(' ') : result.result)
      ?? 'Claude Code stopped with an error.' };
  }
  return { ok: false, error: said ?? 'Claude Code finished without compacting the conversation.' };
}

/**
 * Claude Code's own `/compact`, run headless on the chat it belongs to, in the chat's folder and
 * under the chat's key: a pause from the phone stops it like any run GrantTap started there.
 */
export function compactClaudeSession(session: SessionInfo, timeoutMs = CLAUDE_COMPACT_TIMEOUT_MS): Promise<CompactOutcome> {
  const claude = resolveClaudeBinary();
  let outcome: CompactOutcome | undefined;
  const args = ['-p', '--resume', session.sessionId, '--output-format', 'stream-json', '--verbose', '/compact'];
  return runProcess(claude.path, args, session.cwd, timeoutMs, (stdout) => {
    outcome = readClaudeCompaction(stdout);
    return outcome.ok ? { ok: true, text: '' } : { ok: false, error: outcome.error };
  }, undefined, session.sessionId).then((result) => {
    if (outcome) return outcome.ok ? outcome : { ok: false, error: explainClaudeFailure(outcome.error, claude) };
    return result.ok ? { ok: false, error: 'Claude Code finished without compacting the conversation.' }
      : { ok: false, error: explainClaudeFailure(result.error, claude) };
  });
}
