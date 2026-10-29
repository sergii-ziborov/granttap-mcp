import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { repositorySourceFingerprint } from '..';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-source-state-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(join(root, '.gitignore'), 'generated/\n');
  writeFileSync(join(root, 'source with space.rs'), 'before\n');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Fixture');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const revision = git('rev-parse', 'HEAD');
  return { root, git, revision, read: () => repositorySourceFingerprint(root, revision, { fresh: true }) };
}

test('source observations detect repeated unstaged edits, renames and untracked files without parsing code', async t => {
  const f = fixture(t), initial = await f.read();
  assert.match(initial!, /^[a-f0-9]{64}$/);
  assert.equal(await f.read(), initial);
  writeFileSync(join(f.root, 'source with space.rs'), 'change\n');
  const firstEdit = await f.read();
  assert.notEqual(firstEdit, initial);
  writeFileSync(join(f.root, 'source with space.rs'), 'edited\n');
  const secondEdit = await f.read();
  assert.notEqual(secondEdit, firstEdit, 'The same dirty Git status must not hide a later edit');
  const renamed = 'данные with\nnewline.rs';
  f.git('mv', 'source with space.rs', renamed);
  const moved = await f.read();
  assert.notEqual(moved, secondEdit);
  assert.match(moved!, /^[a-f0-9]{64}$/);
  mkdirSync(join(f.root, 'nested'));
  writeFileSync(join(f.root, 'nested', 'new file.ts'), 'export const value = 1;\n');
  const untracked = await f.read();
  assert.notEqual(untracked, moved);
  mkdirSync(join(f.root, 'generated'));
  writeFileSync(join(f.root, 'generated', 'output.rs'), 'ignored output\n');
  assert.equal(await f.read(), untracked, 'Ignored build output must not trigger another code scan');
  unlinkSync(join(f.root, renamed));
  assert.notEqual(await f.read(), untracked);
  assert.notEqual(await repositorySourceFingerprint(f.root, 'different-head', { fresh: true }), await f.read());
});

test('automatic observations coalesce and expire while explicit refresh and a backwards clock stay fresh', async t => {
  const f = fixture(t), first = repositorySourceFingerprint(f.root, f.revision);
  assert.equal(repositorySourceFingerprint(f.root, f.revision), first);
  const initial = await first;
  writeFileSync(join(f.root, 'source with space.rs'), 'changed\n');
  assert.equal(await repositorySourceFingerprint(f.root, f.revision), initial);
  const clock = Date.now;
  const later = clock() + 6_000;
  try {
    Date.now = () => later;
    const expired = await repositorySourceFingerprint(f.root, f.revision);
    assert.notEqual(expired, initial);
    writeFileSync(join(f.root, 'source with space.rs'), 'another\n');
    Date.now = () => 0;
    assert.notEqual(await repositorySourceFingerprint(f.root, f.revision), expired);
  } finally { Date.now = clock; }
  assert.equal(await repositorySourceFingerprint(join(f.root, 'missing'), f.revision), undefined);
});

test('invalid, escaping and excessive native path lists stay unknown instead of authorizing a stale graph', async t => {
  const f = fixture(t), bin = join(f.root, 'bin'), payload = join(f.root, 'output');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!${process.execPath}\nprocess.stdout.write(require('node:fs').readFileSync(${JSON.stringify(payload)}));\n`, { mode: 0o700 });
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  t.after(() => { process.env.PATH = before; });
  for (const output of ['invalid\0', 'R  target\0', '?? ../outside\0',
    Array(4097).fill('?? file\0').join('')]) {
    writeFileSync(payload, output);
    assert.equal(await f.read(), undefined);
  }
});
