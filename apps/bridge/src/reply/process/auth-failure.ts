import { basename } from 'node:path';
import type { CodingAgent } from '../../../../../packages/protocol/schema';

/**
 * Provider phrases that mean its own login is missing or can no longer be used.
 * Claude Code reports an expired login as `Failed to authenticate: … Run
 * \`claude auth login\`` in its stream-json result while `claude auth status`
 * still says logged in, so the run itself is the evidence.
 */
const SIGN_IN_REQUIRED = new RegExp([
  String.raw`(?:^|\n)\s*(?:not (?:logged|signed) in\b|(?:error:\s*)?authentication required\b|(?:please\s+)?(?:sign|log) in (?:first|to (?:continue|use))\b|to sign in, open this url|failed to authenticate\b|oauth token has expired\b)`,
  String.raw`\brun\s+[\x60'"]?claude\s+(?:auth\s+)?login\b`,
  String.raw`\bplease run /login\b`,
  String.raw`"type"\s*:\s*"authentication_error"`,
].join('|'), 'i');

export function providerAgent(command: string): CodingAgent | undefined {
  const executable = basename(command).toLowerCase();
  return executable.includes('grok') ? 'grok' : executable.includes('claude') ? 'claude'
    : executable.includes('codex') ? 'codex' : executable.includes('cursor') ? 'cursor' : undefined;
}

const PROVIDER_NAMES: Record<CodingAgent, string> = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok', cursor: 'Cursor' };

/** A native sign-in prompt before admission is actionable, not a minute-long delivery timeout. */
export function providerSignInFailure(command: string, ...outputs: string[]): string | undefined {
  const text = outputs.join('\n').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
  if (!SIGN_IN_REQUIRED.test(text)) return;
  const agent = providerAgent(command);
  const provider = agent ? PROVIDER_NAMES[agent] : 'the coding agent';
  return `Sign-in required for ${provider}. Open Devices, choose this computer, then Sign in for ${provider}. This message has not been submitted to the agent.`;
}

export function isSignInFailure(error: string): boolean { return error.startsWith('Sign-in required for '); }

/** Match the provider's explicit diagnostic, not an arbitrary HTTP 402 from a tool. */
export function providerUsageFailure(stderr: string): string | undefined {
  if (!/\bGrok Build usage balance exhausted\b/i.test(stderr)) return;
  return 'Grok usage limit reached: Grok Build usage balance exhausted. Check your Grok usage before retrying.';
}

/**
 * A stream-json run ends with one `result` object. Its raw JSON, cut at 300
 * characters, reached the phone as a broken message; say what it reports.
 */
export function providerResultFailure(stdout: string): string | undefined {
  const lines = stdout.split('\n').map(line => line.trim()).filter(line => line.startsWith('{'));
  for (const line of lines.reverse()) {
    let row: Record<string, unknown>;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type !== 'result' && !('total_cost_usd' in row || 'stop_reason' in row)) continue;
    const said = [row.result, ...(Array.isArray(row.errors) ? row.errors : [])]
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      .map(value => value.trim()).join(' ');
    const kind = typeof row.subtype === 'string' && row.subtype !== 'success'
      ? row.subtype.replace(/^error_/, '').replace(/_/g, ' ') : undefined;
    const reason = said || kind || (typeof row.stop_reason === 'string' ? `stop reason ${row.stop_reason}` : 'no reason given');
    return reason.slice(0, 300);
  }
  return undefined;
}

export function providerExitFailure(command: string, stderr: string, stdout: string, code: number | null): string {
  const signIn = providerSignInFailure(command, stderr, providerResultFailure(stdout) ?? '');
  if (signIn) return signIn;
  const reported = stderr.trim() ? undefined : providerResultFailure(stdout);
  return providerUsageFailure(stderr)
    ?? (reported ? `${basename(command)} stopped with code ${code}: ${reported}`
      : `${command} exited with code ${code}: ${(stderr.trim() || stdout.trim()).slice(0, 300)}`);
}
