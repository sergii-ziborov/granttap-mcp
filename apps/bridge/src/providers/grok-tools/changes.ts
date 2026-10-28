import type { RecordedFileChange } from '../../transcript-history/changes';
import { sensitivePath } from '../../sessions/support/edit-stats';
import { redactSecrets } from '../../sessions/telemetry/command-preview';
import type { GrokToolCall } from './index';
import type { GrokToolCompletion } from './events';

function lines(text: string): string[] {
  return text ? text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : [];
}

/** Proposed replacements are not edits until this session confirms the exact call succeeded. */
export function grokRecordedChanges(
  call: GrokToolCall, completion: GrokToolCompletion | undefined,
): RecordedFileChange[] {
  if (completion?.outcome !== 'success' || completion.name !== call.name || call.name !== 'search_replace'
      || !call.input || typeof call.input !== 'object' || Array.isArray(call.input)) return [];
  const input = call.input as Record<string, unknown>;
  if (typeof input.file_path !== 'string' || !input.file_path || input.file_path.length > 2048
      || /[\\\x00-\x1f]/.test(input.file_path) || input.file_path.split('/').includes('..')
      || sensitivePath(input.file_path) || input.replace_all === true
      || typeof input.old_string !== 'string' || typeof input.new_string !== 'string'
      || input.old_string.length + input.new_string.length > 1_048_576) return [];
  const removed = lines(input.old_string), added = lines(input.new_string);
  if (!removed.length && !added.length) return [];
  const diff = redactSecrets([...removed.map(line => '-' + line), ...added.map(line => '+' + line)].join('\n'));
  return [{ path: input.file_path, linesAdded: added.length, linesRemoved: removed.length,
    diff: diff.slice(0, 16_384), ...(diff.length > 16_384 ? { diffTruncated: true } : {}) }];
}
