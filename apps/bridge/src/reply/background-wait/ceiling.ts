/**
 * How long Claude Code keeps a `claude -p` run GrantTap started alive for the background agents its turn
 * left running. Kept apart from `index.ts` so the provider runner reads it without the queue. See README.md.
 */

/**
 * Claude Code's print-mode ceiling, as GrantTap sets it for the runs it starts: two hours after the turn,
 * the longest the chat catalog expects background work to run. Claude Code's own is ten minutes.
 */
export const CLAUDE_BACKGROUND_CEILING_MS = 2 * 3_600_000;
const CEILING = 'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS';

/** The environment a provider process starts with. A ceiling the computer's environment already sets is kept. */
export function withBackgroundCeiling(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env[CEILING] ? env : { ...env, [CEILING]: String(CLAUDE_BACKGROUND_CEILING_MS) };
}
