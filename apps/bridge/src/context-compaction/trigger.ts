import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionInfo } from '../../../../packages/protocol/schema';

/**
 * GrantTap's own threshold, by provider, for a chat nobody set one for. Claude Code's models have a
 * million-token window and compact themselves at about 967k (the window, less 20k for the summary and
 * a 13k buffer). Every request of a turn sends the whole context again, so a chat held under 400k
 * spends less than half as much of the subscription per request as one near the end, keeps its early
 * messages clearer to the model, and still leaves a long turn more than half the window before
 * Claude's own compaction would have to run in the middle of it. Codex compacts itself near the end
 * of a much smaller window, so it has no default; the person can still set one.
 */
export const DEFAULT_AUTO_COMPACT_TOKENS: Readonly<Partial<Record<string, number>>> = { claude: 400_000 };

/** A turn that ended moments ago may be followed at once by the next queued message; that goes first. */
export const AUTO_COMPACT_QUIET_MS = 20_000;
/** Only a turn that ended lately is compacted after; a chat left long ago is not woken up to be. */
export const AUTO_COMPACT_RECENT_MS = 2 * 60 * 60_000;

const STOPPED_BY_ACCOUNT = new Set(['usage_limit', 'rate_limit', 'sign_in']);

/** What the monitor knows about a chat besides its catalog row, at the moment it looks. */
export type AutoCompactFacts = {
  now: number;
  /** The threshold in force for the chat; undefined when it is off. */
  atTokens?: number;
  /** The context reading an automatic compaction was already tried for. */
  triedReading?: number;
  /** Something runs in the chat or holds it: a GrantTap run, a queued message, an open Claude Code. */
  busy: boolean;
};

/**
 * Whether the chat is due for GrantTap's compaction now: between turns, with a fresh reading of its
 * own at or over the threshold, newer than its last compaction and not tried before. Never while a
 * turn runs, the chat is held or waits on background work, or the account stopped it.
 */
export function autoCompactDue(session: SessionInfo, facts: AutoCompactFacts): boolean {
  const usage = session.contextUsage;
  if (!facts.atTokens || !usage || usage.usedTokens < facts.atTokens || facts.busy) return false;
  if (session.agent !== 'claude' && session.agent !== 'codex') return false;
  if (session.state !== 'idle' || session.paused || session.backgroundTasks || session.usageLimit) return false;
  if (session.stopped && STOPPED_BY_ACCOUNT.has(session.stopped.reason)) return false;
  if (facts.now - session.lastActivityAt < AUTO_COMPACT_QUIET_MS) return false;
  if (facts.now - usage.observedAt > AUTO_COMPACT_RECENT_MS) return false;
  if ((session.compaction?.last?.at ?? 0) >= usage.observedAt) return false;
  return facts.triedReading !== usage.observedAt;
}

function claudeSessionsDir(): string {
  return process.env.GRANTTAP_CLAUDE_SESSIONS_DIR
    ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'sessions');
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

const spaced = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * The process with this id is the one that wrote the entry, not a later one given the same id. Claude
 * writes the start time in UTC on this Mac; it is compared in UTC and in local time.
 */
function sameProcess(pid: number, started: unknown): boolean {
  if (typeof started !== 'string' || !started.trim()) return true;
  const startedAt = (zone: string | undefined) => spaced(execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)],
    { encoding: 'utf8', timeout: 2_000, env: zone ? { ...process.env, TZ: zone } : process.env }));
  try { return [startedAt('UTC'), startedAt(undefined)].includes(spaced(started)); } catch { return true; }
}

/**
 * Whether a running Claude Code holds the chat: Claude lists each of its sessions in
 * `~/.claude/sessions/<pid>.json`. A chat open there keeps its whole conversation in memory, so a
 * compaction written beside it would not reach it; GrantTap leaves such a chat alone.
 */
export function claudeSessionHeld(sessionId: string, dir = claudeSessionsDir()): boolean {
  let names: string[];
  try { names = readdirSync(dir).filter((name) => name.endsWith('.json')).slice(0, 512); } catch { return false; }
  return names.some((name) => {
    try {
      const entry = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const pid = Number(entry?.pid);
      return entry?.sessionId === sessionId && Number.isSafeInteger(pid) && pid > 0 && alive(pid)
        && sameProcess(pid, entry.procStart);
    } catch { return false; }
  });
}
