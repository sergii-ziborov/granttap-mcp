import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ActivityEntry } from '../../../../../packages/protocol/schema';
import type { CapabilityObservation } from '../../sessions/telemetry';

export type GrokParsedContext = { entries: ActivityEntry[]; usage: CapabilityObservation[];
  firstUser?: string; lastMessageAt?: number; tokens: number; lastTurn: number; cacheable?: boolean };
type Source = { fingerprint: string; present: boolean };
type Entry = { contextFingerprint: string; updateFingerprint?: string; context: GrokParsedContext;
  omittedContextEntries: boolean; visible?: ActivityEntry[]; result: GrokParsedContext };
type Identity = { directory: string; sessionId: string; fallbackTime: number };

function source(identity: Identity, names: string[]): Source | undefined {
  let present = false;
  const stamps: string[] = [identity.sessionId, String(identity.fallbackTime)];
  try {
    for (const name of names) {
      try {
        const stat = statSync(join(identity.directory, name), { bigint: true });
        present = true;
        stamps.push([name, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        stamps.push(name + ':missing');
      }
    }
    return { fingerprint: JSON.stringify(stamps), present };
  } catch { return undefined; }
}

export function withGrokVisible(context: GrokParsedContext, visible: ActivityEntry[] | undefined): GrokParsedContext {
  if (visible === undefined) return context;
  let firstUser = context.firstUser, lastMessageAt = context.lastMessageAt ?? 0;
  for (const entry of visible) {
    if (entry.kind === 'user') firstUser ??= entry.text.trim().slice(0, 120);
    if (['user', 'message', 'final'].includes(entry.kind)) lastMessageAt = Math.max(lastMessageAt, entry.createdAt);
  }
  return { ...context, entries: visible, firstUser, lastMessageAt: lastMessageAt || undefined };
}

/** Retain only the current scan's sources; context and the native visible stream advance independently. */
export class GrokCatalogCache {
  private readonly entries = new Map<string, Entry>();

  retain(directories: ReadonlySet<string>): void {
    const keep = new Set([...directories].map(path => resolve(path)));
    for (const key of this.entries.keys()) if (!keep.has(key)) this.entries.delete(key);
  }

  read(identity: Identity, load: { context: () => GrokParsedContext; visible: () => ActivityEntry[] | undefined }): GrokParsedContext {
    const key = resolve(identity.directory), previous = this.entries.get(key);
    const contextSource = source(identity, ['chat_history.jsonl', 'events.jsonl', 'rewind_points.jsonl']);
    const updateSource = source(identity, ['updates.jsonl']);
    const sameContext = contextSource != null && previous?.contextFingerprint === contextSource.fingerprint;
    const sameUpdates = updateSource != null && previous?.updateFingerprint === updateSource.fingerprint;
    if (sameContext && sameUpdates) return previous!.result;
    const loadedVisible = sameUpdates ? undefined : load.visible();
    const visible = sameUpdates ? previous!.visible
      : loadedVisible === undefined ? undefined : structuredClone(loadedVisible);
    const context = sameContext && !(visible === undefined && previous!.omittedContextEntries)
      ? previous!.context : load.context();
    const result = withGrokVisible(context, visible);
    const unchangedContext = contextSource != null && contextSource.fingerprint
      === source(identity, ['chat_history.jsonl', 'events.jsonl', 'rewind_points.jsonl'])?.fingerprint;
    const unchangedUpdates = updateSource != null && updateSource.fingerprint === source(identity, ['updates.jsonl'])?.fingerprint;
    if (unchangedContext && unchangedUpdates && context.cacheable !== false) {
      this.entries.set(key, { contextFingerprint: contextSource!.fingerprint,
        updateFingerprint: visible !== undefined || !updateSource!.present ? updateSource!.fingerprint : undefined,
        context: visible !== undefined ? { ...context, entries: [] } : context,
        omittedContextEntries: visible !== undefined, visible, result });
    }
    return result;
  }
}
