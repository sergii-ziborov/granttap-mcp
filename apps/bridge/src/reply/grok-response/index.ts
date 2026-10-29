import type { ReplyResult } from '../payload/types';
import type { ProviderAdmission } from '../process';
import { providerUsageFailure } from '../process/auth-failure';

function events(stdout: string): Record<string, unknown>[] {
  return stdout.split('\n').flatMap(line => {
    try {
      const value: unknown = JSON.parse(line);
      return value && typeof value === 'object' && !Array.isArray(value)
        ? [value as Record<string, unknown>] : [];
    } catch { return []; }
  });
}

/** Response activity proves admission; startup lists and diagnostic text do not. */
export function grokAccepted(stdout: string): boolean {
  return events(stdout).some(event => {
    if (['text', 'thought'].includes(String(event.type))) {
      return typeof event.data === 'string' && !!event.data.trim();
    }
    if (event.type === 'result') return typeof event.result === 'string' && !!event.result.trim();
    return event.type === 'tool_call' && event.status === 'in_progress'
      && typeof event.toolCallId === 'string' && !!event.toolCallId;
  });
}

/** Opening a native session has a separate limit from executing its long turn. */
export const grokAdmission: ProviderAdmission = {
  confirmed: grokAccepted,
  withinMs: 60_000,
  timeoutMessage: 'Grok did not confirm receipt within 60s. Open the task before retrying.',
};

export function parseGrok(stdout: string, fallback: string): ReplyResult {
  let text = '';
  let sessionId = fallback;
  for (const event of events(stdout)) {
    if (event.type === 'text' && typeof event.data === 'string') text += event.data;
    if (event.type === 'result' && typeof event.result === 'string') text = event.result;
    if (typeof event.sessionId === 'string') sessionId = event.sessionId;
    if (typeof event.session_id === 'string') sessionId = event.session_id;
    const error = typeof event.message === 'string' ? event.message : event.error;
    if (event.type === 'error' && typeof error === 'string') {
      return { ok: false, error: providerUsageFailure(error) ?? error.slice(0, 500) };
    }
  }
  return text.trim() ? { ok: true, text: text.trim().slice(0, 4_000), sessionId }
    : { ok: false, error: 'Grok Build returned an empty response.' };
}
