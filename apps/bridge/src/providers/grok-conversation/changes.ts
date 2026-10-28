import type { RecordedFileChange } from '../../transcript-history/changes';
import { sensitivePath } from '../../sessions/support/edit-stats';
import { redactSecrets } from '../../sessions/telemetry/command-preview';

/** Native ACP diffs are consulted only by the successful tool completion path. */
export function confirmedUpdateChanges(content: unknown): RecordedFileChange[] {
  if (!Array.isArray(content)) return [];
  return content.slice(0, 64).flatMap(raw => {
    if (!raw || typeof raw !== 'object' || raw.type !== 'diff' || typeof raw.path !== 'string'
        || !raw.path || raw.path.length > 2048 || sensitivePath(raw.path)
        || /[\\\x00-\x1f]/.test(raw.path) || raw.path.split('/').includes('..')
        || typeof raw.oldText !== 'string' || typeof raw.newText !== 'string'
        || raw.oldText.length + raw.newText.length > 1_048_576) return [];
    const split = (text: string): string[] => text ? text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : [];
    const before = split(raw.oldText), after = split(raw.newText);
    let start = 0, endBefore = before.length, endAfter = after.length;
    while (start < endBefore && start < endAfter && before[start] === after[start]) start++;
    while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
      endBefore--; endAfter--;
    }
    const removed = before.slice(start, endBefore), added = after.slice(start, endAfter);
    if (!removed.length && !added.length) return [];
    const diff = redactSecrets([...removed.map(line => '-' + line), ...added.map(line => '+' + line)].join('\n'));
    return [{ path: raw.path, linesAdded: added.length, linesRemoved: removed.length,
      diff: diff.slice(0, 16_384), ...(diff.length > 16_384 ? { diffTruncated: true } : {}) }];
  });
}
