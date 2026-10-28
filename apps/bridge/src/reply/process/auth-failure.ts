import { basename } from 'node:path';

/** A native sign-in prompt before admission is actionable, not a minute-long delivery timeout. */
export function providerSignInFailure(command: string, stderr: string): string | undefined {
  const text = stderr.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
  if (!/(?:^|\n)\s*(?:not (?:logged|signed) in\b|(?:error:\s*)?authentication required\b|(?:please\s+)?(?:sign|log) in (?:first|to (?:continue|use))\b|to sign in, open this url)/i.test(text)) return;
  const executable = basename(command).toLowerCase();
  const provider = executable.includes('grok') ? 'Grok' : executable.includes('claude') ? 'Claude Code'
    : executable.includes('codex') ? 'Codex' : executable.includes('cursor') ? 'Cursor' : 'the coding agent';
  return `Sign-in required for ${provider}. Open Devices, choose this computer, then Sign in for ${provider}. This message has not been submitted to the agent.`;
}
