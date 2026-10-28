import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { localTaskTransfers } from '../index';
import { protectedGrantTapAccess } from '../../host/self-protection';
import type { TaskCapsule } from '../../../../../packages/protocol/schema';

test('an admitted provider can read its materialized transfer context without access to trust state', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-provider-context-'));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const facts: TaskCapsule = { taskId: 'fixture-task', goal: 'Synthetic verification', currentStatus: 'Idle',
    sourceProvider: 'cursor', sourceComputer: 'fixture', targetProvider: 'codex', targetComputer: 'fixture',
    repository: 'fixture', baseSha: 'a'.repeat(40), filesChanged: [], dependencies: [],
    resourceClaims: [], remainingWork: [], importantDecisions: [], createdAt: 1 };
  const context = JSON.stringify({ version: 1, facts,
    entries: [{ id: 'fixture-answer', role: 'assistant', text: 'Retained fixture answer', at: 1 }] });
  const store = localTaskTransfers();
  const row = store.prepare({ eventId: 'fixture-provider-context', projectId: 'fixture-project',
    sourceSessionId: 'fixture-source', title: 'Fixture transfer', capsule: facts, context,
    workspace: join(root, 'worktrees', 'fixture'), branch: 'codex/fixture', acceptedAt: 1 });
  const path = store.providerContextPath(row.sessionId);
  assert.equal(protectedGrantTapAccess('Read', { file_path: path }), null);
  assert.equal(protectedGrantTapAccess('exec_command', { cmd: `sed -n '1,80p' '${path}'` }), null);
  assert.match(readFileSync(path, 'utf8'), /Retained fixture answer/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(protectedGrantTapAccess('Read', { file_path: store.contextPath(row.sessionId) }));
  assert.ok(protectedGrantTapAccess('Read', { file_path: join(root, 'machine.json') }));
  assert.ok(protectedGrantTapAccess('exec_command', { cmd: `cat '${path}' '${join(root, 'machine.json')}'` }));
  writeFileSync(path, 'Untrusted provider-side edit');
  assert.match(readFileSync(store.providerContextPath(row.sessionId), 'utf8'), /Retained fixture answer/);
  assert.equal(readFileSync(store.contextPath(row.sessionId)!, 'utf8'), context);
});
