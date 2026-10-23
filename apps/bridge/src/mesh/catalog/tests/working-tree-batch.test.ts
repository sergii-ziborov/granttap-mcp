import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SessionInfo } from '../../../../../../packages/protocol/schema';
import { MeshStore } from '../../store';
import { linkSessionsToProjects } from '..';

test('one catalog shares a checkout reading across chats and the next catalog reads fresh work', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-checkout-batch-'));
  const repo = join(root, 'repo'), bin = join(root, 'bin'), calls = join(root, 'status-calls');
  mkdirSync(repo); mkdirSync(bin);
  execFileSync('/usr/bin/git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'README.md'), 'base\n');
  execFileSync('/usr/bin/git', ['-C', repo, 'add', '.']);
  execFileSync('/usr/bin/git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.test',
    'commit', '-qm', 'base']);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nif [ "$3" = status ]; then printf 'status\\n' >> '${calls}'; fi\nexec /usr/bin/git "$@"\n`, { mode: 0o700 });
  const prior = process.env.PATH;
  process.env.PATH = `${bin}:${prior}`;
  t.after(() => { process.env.PATH = prior; rmSync(root, { recursive: true, force: true }); });
  const store = new MeshStore(join(root, 'mesh.json'), () => 20);
  const sessions: SessionInfo[] = Array.from({ length: 6 }, (_, n) => ({ sessionId: `chat-${n}`,
    agent: 'codex', cwd: repo, state: 'idle', startedAt: 1, lastActivityAt: 10,
    tokensSession: 0, tokensLastTurn: 0 }));
  const first = linkSessionsToProjects(store, sessions, 'mac');
  assert.equal(store.snapshot(first[0]!.projectId!)?.executions.every(row => row.uncommitted === false), true);
  assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 1,
    'Repeated synchronous git status for the same checkout delays transfers and blocks relay activity');
  writeFileSync(join(repo, 'new-file.txt'), 'uncommitted work');
  linkSessionsToProjects(store, sessions, 'mac');
  assert.equal(store.snapshot(first[0]!.projectId!)?.executions.every(row => row.uncommitted === true), true);
  assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 2,
    'A previous batch must never hide later uncommitted work');
});
