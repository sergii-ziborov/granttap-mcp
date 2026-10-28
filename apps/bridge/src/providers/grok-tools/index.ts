import { redactSecrets } from '../../sessions/telemetry/command-preview';
import { toolSummary } from '../../sessions/support/activity-helpers';
export { grokToolCompletions, type GrokToolCompletion } from './events';
export { grokRecordedChanges } from './changes';

export type GrokToolCall = {
  id?: string;
  name: string;
  input: unknown;
  ordinal: number;
  typed: boolean;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function argumentsObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return object(value);
  if (value.length > 1_048_576) return undefined;
  try { return object(JSON.parse(value)); } catch { return undefined; }
}

/** Native flat tool_calls and older content blocks carry the same observed call. */
export function grokToolCalls(message: Record<string, unknown>): GrokToolCall[] {
  const result: GrokToolCall[] = [], seen = new Set<string>();
  const append = (raw: unknown, ordinal: number, typed: boolean): void => {
    const call = object(raw);
    if (!call) return;
    const fn = typed ? object(call.function) ?? call : call;
    if (typeof fn.name !== 'string' || !fn.name.trim() || fn.name.length > 240) return;
    const id = typeof call.id === 'string' && call.id.trim() && call.id.length <= 512 ? call.id : undefined;
    if (id && seen.has(id)) return;
    if (id) seen.add(id);
    result.push({ id, name: fn.name, input: argumentsObject(typed ? fn.arguments : call.input), ordinal, typed });
  };
  if (Array.isArray(message.content)) {
    message.content.slice(0, 64).forEach((raw, index) => {
      if (object(raw)?.type === 'tool_use') append(raw, index, false);
    });
  }
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.slice(0, 64 - result.length).forEach((raw, index) => append(raw, index, true));
  }
  return result;
}

/** A path alias improves read_file feedback; arbitrary argument payloads never become summaries. */
export function grokToolSummary(call: GrokToolCall): string {
  const input = object(call.input);
  const normalized = input && typeof input.target_file === 'string' && input.file_path == null
    ? { ...input, file_path: input.target_file } : input;
  return redactSecrets(toolSummary(call.name, normalized));
}
