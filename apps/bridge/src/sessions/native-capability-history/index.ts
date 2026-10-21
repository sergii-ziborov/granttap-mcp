import type { CapabilityExecutionSummary, RemoteCapabilityUsageEvent, SessionInfo } from '../../../../../packages/protocol/schema';
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { codexSessionsRoot } from '../support/common';
export { completedCodexMcp, recordedCodexToolName } from './completed-item';
export type NativeCapabilityEvidence = {
  scopes: string[];
  events: RemoteCapabilityUsageEvent[];
  summaries: CapabilityExecutionSummary[];
};

const empty = (): NativeCapabilityEvidence => ({ scopes: [], events: [], summaries: [] });
const cache = new Map<string, { at: number; value: Promise<NativeCapabilityEvidence> }>();
type Cursor = { threadId: string; watermark: number; events: RemoteCapabilityUsageEvent[] };
const cursors = new Map<string, Cursor[]>();

/** Query only bounded call metadata in a worker; native conversation contents stay local. */
export function readCodexCapabilityHistory(
  sessions: SessionInfo[], root = process.env.GRANTTAP_CODEX_DIR ?? process.env.NODVOX_CODEX_DIR
    ?? process.env.CODEX_HOME ?? dirname(codexSessionsRoot()),
): Promise<NativeCapabilityEvidence> {
  const database = join(root, 'thread_history_1.sqlite');
  const owners = new Map<string, string>();
  for (const session of sessions.filter(s => s.agent === 'codex')) {
    owners.set(session.sessionId, session.sessionId);
    for (const child of session.childThreads ?? []) {
      if (!owners.has(child.threadId)) owners.set(child.threadId, session.sessionId);
    }
  }
  const bindings = [...owners].slice(0, 512);
  if (!bindings.length || !existsSync(database)) return Promise.resolve(empty());
  const key = JSON.stringify([database, bindings]);
  const previous = cache.get(key);
  if (previous && Date.now() - previous.at < 30_000) return previous.value;
  const value = readWorker(database, bindings);
  cache.set(key, { at: Date.now(), value });
  while (cache.size > 4) cache.delete(cache.keys().next().value!);
  return value;
}

function readWorker(database: string, bindings: [string, string][]): Promise<NativeCapabilityEvidence> {
  return new Promise(resolve => {
    const requested = new Set(bindings.map(([thread]) => thread));
    const worker = new Worker(new URL('./reader.js', import.meta.url), { execArgv: [],
      workerData: { database, bindings, now: Date.now(),
        previous: (cursors.get(database) ?? []).filter(cursor => requested.has(cursor.threadId)) },
      resourceLimits: { maxOldGenerationSizeMb: 64 } });
    let evidence = empty();
    const timer = setTimeout(() => { void worker.terminate(); }, 45_000);
    worker.once('message', (result: NativeCapabilityEvidence & { cursors?: Cursor[] }) => {
      const { cursors: next, ...publicEvidence } = result;
      if (next) {
        const merged = [...next, ...(cursors.get(database) ?? []).filter(cursor => !requested.has(cursor.threadId))];
        let count = 0;
        cursors.set(database, merged.filter(cursor => {
          count += cursor.events.length;
          return count <= 20000;
        }).slice(0, 512));
        while (cursors.size > 4) cursors.delete(cursors.keys().next().value!);
      }
      evidence = publicEvidence;
    });
    worker.once('error', () => { evidence = empty(); });
    worker.once('exit', code => { clearTimeout(timer); resolve(code === 0 ? evidence : empty()); });
  });
}
