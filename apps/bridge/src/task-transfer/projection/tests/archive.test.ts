import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PreparedTaskTransfers } from '../../index';
import { TransferProjection } from '../storage';

const capsule = { taskId: 'task', goal: 'Synthetic task', currentStatus: 'Ready',
  sourceProvider: 'codex' as const, sourceComputer: 'source', targetProvider: 'grok' as const,
  targetComputer: 'target', repository: 'repo', baseSha: 'a'.repeat(40), filesChanged: [],
  dependencies: [], resourceClaims: [], remainingWork: [], importantDecisions: [], createdAt: 1 };

test('transferred history and photo chunks stay readable without loading the full context archive', () => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-projection-'));
  try {
    const image = Buffer.alloc(150_000, 42);
    const entries = Array.from({ length: 91 }, (_, i) => ({ id: `entry-${i}`, role: 'user',
      text: `Synthetic message ${i}`, at: i, ...(i === 90 ? { images: [{ id: 'photo',
        name: 'photo.png', mime: 'image/png', data: image.toString('base64') }] } : {}) }));
    const transfers = new PreparedTaskTransfers(root);
    const row = transfers.prepare({ eventId: 'paged', projectId: 'project', sourceSessionId: 'source',
      title: 'Task', capsule, workspace: '/fixture', branch: 'granttap/fixture', acceptedAt: 1,
      context: JSON.stringify({ version: 1, facts: capsule, entries }) });
    renameSync(transfers.contextPath(row.sessionId)!, join(root, 'large-archive-not-in-hot-path'));
    const projection = new TransferProjection(root, row.sessionId);
    const latest = projection.page();
    assert.equal(latest?.entries.length, 40);
    assert.equal(latest?.entries.at(-1)?.id, 'entry-90');
    assert.equal(latest?.entries[0]?.id, 'entry-51');
    const older = projection.page(51);
    assert.equal(older?.entries.length, 40);
    assert.equal(older?.entries[0]?.id, 'entry-11');
    assert.equal(projection.page(11)?.entries.length, 11);
    assert.equal(projection.page(92), undefined);
    const chunk = projection.image('photo', 65_536);
    assert.equal(chunk?.total_bytes, image.length);
    assert.deepEqual(Buffer.from(chunk!.data_base64, 'base64'), image.subarray(65_536, 131_072));
    assert.equal(projection.image('photo', -1), undefined);
    assert.equal(projection.image('photo', image.length), undefined);
    assert.equal(projection.image('../photo', 0), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
