import { safeParse, ts } from '../../../support/common';

/** Forked rollouts begin with their own metadata, then a copied parent log. */
export function ownCodexLines(lines: string[]): string[] {
  const first = lines.find(line => safeParse(line)?.type === 'session_meta');
  if (!first) return lines;
  const native = safeParse(first);
  const meta = native?.payload;
  if (!meta?.source?.subagent?.thread_spawn?.parent_thread_id) return lines;
  const startedAt = ts(native.timestamp ?? meta.timestamp);
  return lines.filter(line => {
    const row = safeParse(line);
    if (!row) return false;
    if (row.type === 'session_meta') return row.payload?.id === meta.id;
    const at = ts(row.timestamp);
    return !startedAt || !at || at >= startedAt;
  });
}
