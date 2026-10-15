import { randomUUID } from 'node:crypto';
import type { RoutingRequest, RoutingRequests } from './index';

type Session = { sessionId: string; projectId?: string; taskId?: string; agent: string; state: string; model?: string; effort?: string };
type Options = { store: RoutingRequests; now?: () => number;
  session: (id: string) => Session | undefined | Promise<Session | undefined>;
  route: (request: RoutingRequest, session: Session) => Promise<boolean | 'wait'>;
  recover?: (request: RoutingRequest) => Promise<'submitted' | 'failed'>;
  onChange?: (request: RoutingRequest) => void };

/** A provider's explicit request is processed after its current turn has finished. */
export class RoutingRequestProcessor {
  private readonly owner = `${process.pid}:${randomUUID()}`;
  private busy = false;
  constructor(private readonly input: Options) {}

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const row of this.input.store.pending()) await this.process(row);
    } finally { this.busy = false; }
  }

  private async process(row: RoutingRequest): Promise<void> {
    const now = (this.input.now ?? Date.now)(), store = this.input.store;
    if (row.expiresAt <= now) { store.finish(row.id, 'failed', 'expired', now); this.changed(row); return; }
    if ((row.nextAttemptAt ?? 0) > now) return;
    if (row.phase === 'preparing') {
      if (alive(row.owner)) return;
      const phase = await this.input.recover?.(row) ?? 'failed';
      store.finish(row.id, phase, 'recovered', now); this.changed(row); return;
    }
    const session = await this.input.session(row.source.sessionId);
    if (!session || session.agent !== row.source.provider || session.projectId !== row.source.projectId
      || session.taskId !== row.source.taskId) {
      store.finish(row.id, 'failed', 'source_changed', now); this.changed(row); return;
    }
    if (session.state !== 'idle') return;
    if (session.model !== row.source.model || session.effort !== row.source.effort) {
      store.finish(row.id, 'failed', 'source_changed', now); this.changed(row); return;
    }
    if (!store.begin(row.id, this.owner, now)) return;
    try {
      const accepted = await this.input.route(row, session);
      if (accepted === 'wait') { store.wait(row.id, this.owner, now); return; }
      store.finish(row.id, accepted ? 'submitted' : 'failed', accepted ? 'durably_queued' : 'no_compatible_computer', now, this.owner);
    } catch { store.finish(row.id, 'failed', 'preparation_failed', now, this.owner); }
    this.changed(row);
  }
  private changed(row: RoutingRequest): void { this.input.onChange?.(this.input.store.get(row.id) ?? row); }
}

function alive(owner: string | undefined): boolean {
  const pid = Number(owner?.split(':')[0]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
