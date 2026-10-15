import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHandoffWorktree } from '../../worktree';

test('a prepared handoff recovers its own clean worktree after a crash without creating another branch', () => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-worktree-recovery-'));
  try {
    const repository = join(root, 'repository'); mkdirSync(repository);
    const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    git('init'); writeFileSync(join(repository, 'file.txt'), 'Synthetic fixture'); git('add', '.');
    git('-c', 'user.name=sergii-ziborov', '-c', 'user.email=sergii.ziborov@gmail.com', 'commit', '-qm', 'Synthetic fixture');
    const input = { repository, worktreeRoot: join(root, 'worktrees'), taskId: 'task', provider: 'grok',
      baseSha: git('rev-parse', 'HEAD'), operationId: 'prepared-transfer-event' };
    const first = createHandoffWorktree({ ...input, now: 1 });
    assert.ok(first);
    const recovered = createHandoffWorktree({ ...input, now: 2 });
    assert.deepEqual(recovered, first);
    writeFileSync(join(first.path, 'file.txt'), 'Owner changes must survive.');
    assert.equal(createHandoffWorktree({ ...input, now: 3 }), undefined);
    assert.ok(git('worktree', 'list').includes(first.path));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
