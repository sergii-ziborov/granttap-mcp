import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TaskCapsule } from '../../../../../../../packages/protocol/schema';
import { dirtyDiffHash } from '../../../admin/capsule';
import { sourceCheckoutUnchanged } from '../source-checkout';

function repository(): { root: string; head: () => string; commit: (text: string) => void } {
  const root = mkdtempSync(join(tmpdir(), 'granttap-source-checkout-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Test',
    '-c', 'user.email=test@example.test', ...args], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', root]);
  const commit = (text: string) => {
    writeFileSync(join(root, 'README.md'), text);
    git('add', 'README.md');
    git('commit', '-q', '-m', text.trim());
  };
  commit('base\n');
  return { root, head: () => git('rev-parse', 'HEAD'), commit };
}

function capsule(baseSha: string, facts: Partial<TaskCapsule>): TaskCapsule {
  return { baseSha, latestCommit: baseSha, ...facts } as TaskCapsule;
}

test('a clean source stays confirmable only while nothing moved', () => {
  const repo = repository();
  try {
    const prepared = capsule(repo.head(), { workingTree: 'clean' });
    assert.equal(sourceCheckoutUnchanged(repo.root, prepared), true);
    writeFileSync(join(repo.root, 'README.md'), 'edited after preparation\n');
    assert.equal(sourceCheckoutUnchanged(repo.root, prepared), false, 'new uncommitted work was not agreed to');
    repo.commit('committed after preparation\n');
    assert.equal(sourceCheckoutUnchanged(repo.root, prepared), false, 'a new commit is a different source');
    assert.equal(sourceCheckoutUnchanged(undefined, prepared), false);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

test('uncommitted work left behind must still be the same work at confirmation', () => {
  const repo = repository();
  try {
    writeFileSync(join(repo.root, 'README.md'), 'left behind\n');
    const prepared = capsule(repo.head(), { workingTree: 'dirty', dirtyDiffHash: dirtyDiffHash(repo.root) });
    assert.equal(sourceCheckoutUnchanged(repo.root, prepared), true);
    writeFileSync(join(repo.root, 'README.md'), 'left behind, then changed again\n');
    assert.equal(sourceCheckoutUnchanged(repo.root, prepared), false);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

test('a checkpoint carries the work, so the source only has to keep its commit', () => {
  const repo = repository();
  try {
    writeFileSync(join(repo.root, 'README.md'), 'checkpointed\n');
    const prepared = capsule(repo.head(), { workingTree: 'clean', latestCommit: 'f'.repeat(40),
      checkpoint: { status: 'complete', files: 1, excluded: [] } });
    assert.equal(sourceCheckoutUnchanged(repo.root, prepared), true);
    repo.commit('moved on\n');
    assert.equal(sourceCheckoutUnchanged(repo.root, prepared), false);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});
