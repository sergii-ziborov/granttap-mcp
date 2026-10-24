import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { MeshEvent, SessionInfo } from '../../../../../../../packages/protocol/schema';
import { MeshStore } from '../../../store';
import { createMeshRuntime } from '../..';
import { PreparedTaskTransfers, TransferContinuations, transferDigest } from '../../../../task-transfer';

for (const mode of ['slow', 'offline'] as const) test(`a local prepared destination survives ${mode} phone publication`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-local-confirmation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, 'README.md'), 'Committed synthetic work\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'base']);
  const store = new MeshStore(join(root, 'mesh.json'));
  const transfers = new PreparedTaskTransfers(join(root, 'transfers'));
  const continuations = new TransferContinuations(join(root, 'continuations'));
  const sessions: SessionInfo[] = [{ sessionId: 'source', agent: 'claude', cwd: root, state: 'idle',
    title: 'Synthetic task', startedAt: 1, lastActivityAt: 2, tokensSession: 0, tokensLastTurn: 0 }];
  let release!: () => void, started!: () => void, sequence = 0, invocations = 0;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const sending = new Promise<void>(resolve => { started = resolve; });
  const notifications: MeshEvent[] = [];
  const runtime = createMeshRuntime({ store: () => store, sessions: () => sessions, computer: () => 'mac',
    now: Date.now, eventId: () => `event-${sequence++}`, providerEnabled: () => true,
    transfers: () => transfers, continuations: () => continuations,
    captureTransferContext: async (_, facts) => {
      const context = JSON.stringify({ version: 1, facts, entries: [] });
      return { context, hash: transferDigest(context) };
    },
    start: async () => { invocations++; return { ok: true, sessionId: 'unexpected', text: '' }; },
    deliver: async () => ({ ok: true, text: '' }), hasCommit: () => true, fetch: () => false,
    push: () => ({ ok: true, remote: 'origin' }),
    worktree: () => ({ path: join(root, 'isolated'), branch: 'granttap/isolated' }),
    send: async (_, event) => {
      notifications.push(event as MeshEvent); started();
      if (mode === 'offline') throw new Error('Synthetic disconnected phone');
      await blocked;
    },
  });
  const source = runtime.catalog(sessions)[0]!;
  const operation = runtime.prepare({} as any, { type: 'mesh.handoff.prepare', sessionId: source.sessionId,
    projectId: source.projectId!, taskId: source.taskId!, targetProvider: 'grok', targetComputer: 'mac',
    prepareOnly: true, createdAt: Date.now() });
  await sending;
  let accepted = false;
  try {
    const prepared = transfers.catalog([])[0];
    assert.ok(prepared, 'Phone publication must not delay preparation on the same computer.');
    assert.equal(store.task(source.taskId!)?.ownerSessionId, prepared.sessionId);
    assert.ok(store.eventsForProject(source.projectId!).some(event => event.eventType === 'HANDOFF_ACCEPTED'));
    assert.equal(invocations, 0, 'Preparation never starts a provider without the first message.');
  } finally { release(); accepted = await operation; }
  assert.equal(accepted, true, 'A durable preparation is not undone by phone publication failure.');
  assert.deepEqual(notifications.map(event => event.eventType), ['HANDOFF_REQUEST', 'HANDOFF_ACCEPTED']);
});
