import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCodexRolloutIdentityLookup } from '..';

const meta = (id: string) => JSON.stringify({ type: 'session_meta', payload: { id } });

test('unchanged identities are reused, but same-size replacement with a preserved timestamp is reread', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-rollout-identities-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'rollout.jsonl');
  writeFileSync(file, meta('old')); utimesSync(file, 1_000_000, 1_000_000);
  let reads = 0;
  const find = createCodexRolloutIdentityLookup(path => { reads++; return readFileSync(path, 'utf8').split('\n'); });
  assert.equal(find('old', [file]), file);
  assert.equal(find('unavailable', [file]), undefined);
  assert.equal(find('old', [file]), file);
  assert.equal(reads, 1);
  const replacement = join(root, 'replacement'); writeFileSync(replacement, meta('new'));
  utimesSync(replacement, 1_000_000, 1_000_000);
  const before = statSync(file); renameSync(replacement, file);
  const after = statSync(file);
  assert.equal(before.size, after.size); assert.equal(before.mtimeMs, after.mtimeMs);
  assert.equal(find('old', [file]), undefined);
  assert.equal(find('new', [file]), file);
  assert.equal(reads, 2);
});

test('changing, unreadable, deleted and non-file candidates cannot retain an old identity', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-rollout-change-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'rollout.jsonl'); writeFileSync(file, meta('before'));
  let changes = true, fails = false;
  const find = createCodexRolloutIdentityLookup(path => {
    if (fails) throw Error('Synthetic provider read failure');
    const lines = readFileSync(path, 'utf8').split('\n');
    if (changes) { changes = false; writeFileSync(path, meta('after')); }
    return lines;
  });
  assert.equal(find('before', [file]), undefined);
  assert.equal(find('after', [file]), file);
  writeFileSync(file, meta('latest')); fails = true;
  assert.equal(find('after', [file]), undefined);
  fails = false;
  assert.equal(find('latest', [file]), file);
  rmSync(file); assert.equal(find('latest', [file]), undefined);
  assert.equal(find('latest', [root]), undefined);
});

test('an identity-free file is reusable and historical paths have bounded retention', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-rollout-retention-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let reads = 0;
  const find = createCodexRolloutIdentityLookup(path => { reads++; return readFileSync(path, 'utf8').split('\n'); });
  const empty = join(root, 'empty'); writeFileSync(empty, 'invalid JSON\n{}\n');
  assert.equal(find('unknown', [empty]), undefined);
  assert.equal(find('unknown', [empty]), undefined);
  assert.equal(reads, 1);
  for (let index = 0; index < 256; index++) {
    const file = join(root, String(index)); writeFileSync(file, meta(String(index)));
    assert.equal(find(String(index), [file]), file);
  }
  assert.equal(find('unknown', [empty]), undefined);
  assert.equal(reads, 258, 'The oldest path is reread after the bounded identity cache evicts it');
});
