import type { ActivityEntry } from '../../../../../../packages/protocol/schema';
import { confirmedUpdateChanges } from '../../../providers/acp-file-changes';
import { redactSecrets } from '../../telemetry/command-preview';

/** Native ACP facts only: bounded titles, exact call identity and confirmed diffs. */
export class CursorConversationTools {
  private readonly pending = new Map<string, { entry: ActivityEntry; proposed: ReturnType<typeof confirmedUpdateChanges> }>();
  private readonly seen = new Set<string>();
  constructor(private readonly sessionId: string, private readonly write: (entry: ActivityEntry) => void) {}

  update(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const value = raw as Record<string, unknown>, id = value.toolCallId;
    if (typeof id !== 'string' || !id || id.length > 256) return;
    if (value.sessionUpdate === 'tool_call' && !this.seen.has(id)) {
      const name = { read: 'Read', edit: 'Edit', execute: 'Shell', search: 'Search' }[String(value.kind)] ?? 'Tool';
      const title = typeof value.title === 'string' ? value.title : name;
      const entry: ActivityEntry = { id: `${this.sessionId}:tool:${id}`, kind: 'tool', toolName: name,
        text: redactSecrets(title.replace(/\s+/g, ' ').trim()).slice(0, 700) || name, createdAt: Date.now() };
      this.seen.add(id);
      while (this.seen.size > 256) this.seen.delete(this.seen.keys().next().value!);
      this.pending.set(id, { entry, proposed: confirmedUpdateChanges(value.content) }); this.write(entry);
      while (this.pending.size > 64) this.pending.delete(this.pending.keys().next().value!);
    } else if (value.sessionUpdate === 'tool_call_update') {
      const call = this.pending.get(id);
      if (!call) return;
      const changes = confirmedUpdateChanges(value.content);
      if (changes.length) call.proposed = changes;
      if (!['completed', 'failed'].includes(String(value.status))) return;
      const files = value.status === 'completed' ? call.proposed : [];
      this.write({ ...call.entry, outcome: value.status === 'completed' ? 'success' : 'error',
        ...(files.length ? { fileChanges: files } : {}) });
      this.pending.delete(id);
    }
  }
}
