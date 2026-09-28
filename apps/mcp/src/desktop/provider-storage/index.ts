import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rename, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { callSweepLoom } from './scanner';
import { storageFingerprint } from './fingerprint';

type Row = { id: string; name: string; category: string; bytes: number; cleanable: boolean; reason?: string };
type Planned = { path: string; fingerprint: string; provider: string };
type Store = { title: string; path: string; logical_bytes: number; capped: boolean;
  entries: { relative: string; class: string; logical_bytes: number; can_clean: boolean }[] };
type Dependencies = { home?: string; now?: () => number; call?: (tool: string) => Promise<unknown> };
const operation = 'desktop.provider_storage';
const providers = ['codex', 'claude', 'cursor'];

/** Only the same-user desktop surface can review and trash a selected cache. */
export class ProviderStorage {
  private plan?: { id: string; expires: number; rows: Map<string, Planned> };
  private readonly home: string;
  private readonly now: () => number;
  private readonly call: (tool: string) => Promise<unknown>;
  constructor(dependencies: Dependencies = {}) {
    this.home = dependencies.home ?? homedir();
    this.now = dependencies.now ?? Date.now;
    this.call = dependencies.call ?? callSweepLoom;
  }

  async read(input: unknown): Promise<unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid storage request');
    const request = input as Record<string, unknown>;
    if (request.action === 'inspect') return this.inspect();
    if (request.action === 'trash') return this.trash(request);
    throw new Error('Unknown storage action');
  }

  private async inspect(): Promise<unknown> {
    this.plan = undefined;
    let raw: unknown;
    let busy: Set<string>;
    try { raw = await this.call('list_ai_stores'); busy = await this.busyProviders(); }
    catch { return { operation, available: false, stores: [] }; }
    if (!Array.isArray(raw) || raw.length > 32) throw new Error('Invalid storage inventory');
    const canonicalHome = await realpath(this.home);
    const rows = new Map<string, Planned>();
    const stores: { name: string; bytes: number; capped: boolean; entries: Row[] }[] = [];
    for (const value of raw) {
      const store = value as Store;
      const provider = providers.find(name => store.path === join(this.home, `.${name}`));
      if (!provider || !Array.isArray(store.entries) || store.entries.length > 1024) continue;
      const root = await realpath(store.path).catch(() => '');
      if (root !== join(canonicalHome, `.${provider}`)) continue;
      const entries: Row[] = [];
      for (const item of store.entries.slice(0, 128)) {
        if (typeof item.relative !== 'string' || !Number.isSafeInteger(item.logical_bytes) || item.logical_bytes < 0) continue;
        const path = resolve(root, item.relative);
        const child = relative(root, path);
        if (!child || child.startsWith('..') || isAbsolute(child)) continue;
        const row: Row = { id: randomUUID(), name: child, category: item.class,
          bytes: item.logical_bytes, cleanable: false };
        if (item.can_clean && ['Cache', 'Log'].includes(item.class) && !store.capped) {
          if (busy.has(provider)) row.reason = 'provider-running';
          else {
            try {
              rows.set(row.id, { path, provider, fingerprint: await storageFingerprint(path) });
              row.cleanable = true;
            } catch { row.reason = 'protected-or-changed'; }
          }
        }
        entries.push(row);
      }
      stores.push({ name: provider, bytes: store.logical_bytes, capped: store.capped, entries });
    }
    const planId = randomUUID();
    this.plan = { id: planId, expires: this.now() + 5 * 60_000, rows };
    return { operation, available: true, planId, stores };
  }

  private async busyProviders(): Promise<Set<string>> {
    const sessions = await this.call('list_sessions');
    if (!Array.isArray(sessions) || sessions.some(row => typeof row?.kind !== 'string')) {
      throw new Error('Process inspection unavailable');
    }
    return new Set(providers.filter(provider => sessions.some(row =>
      row.kind.toLowerCase().includes(provider))));
  }

  private async trash(request: Record<string, unknown>): Promise<unknown> {
    const plan = this.plan;
    if (request.confirm !== 'true' || !plan || request.planId !== plan.id || plan.expires <= this.now()
      || typeof request.ids !== 'string' || request.ids.length > 4096) throw new Error('Review storage again');
    const ids: unknown = JSON.parse(request.ids);
    if (!Array.isArray(ids) || !ids.length || ids.length > 16 || new Set(ids).size !== ids.length
      || ids.some(id => typeof id !== 'string' || !plan.rows.has(id))) throw new Error('Invalid cache selection');
    // Consume once: failures require a fresh review and confirmation.
    this.plan = undefined;
    const selected = ids.map(id => plan.rows.get(id)!);
    const busy = await this.busyProviders();
    for (const row of selected) {
      if (busy.has(row.provider) || await storageFingerprint(row.path) !== row.fingerprint) {
        throw new Error('Cache changed or provider is running; inspect again');
      }
    }
    const trash = join(await realpath(this.home), '.Trash');
    await mkdir(trash, { recursive: true, mode: 0o700 });
    const destination = await lstat(trash);
    if (!destination.isDirectory() || destination.isSymbolicLink() || await realpath(trash) !== trash) {
      throw new Error('System Trash must be a local directory');
    }
    // A same-volume rename preserves recovery through the system Trash.
    let moved = 0;
    for (const row of selected) {
      await rename(row.path, join(trash, `GrantTap-${randomUUID()}-${basename(row.path)}`));
      moved++;
    }
    return { operation, available: true, moved };
  }
}
