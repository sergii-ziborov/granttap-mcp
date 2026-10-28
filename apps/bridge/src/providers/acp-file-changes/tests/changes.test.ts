import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmedUpdateChanges } from '../index';

test('native ACP diffs preserve changed lines while excluding unchanged context', () => {
  const files = confirmedUpdateChanges([{ type: 'diff', path: 'fixture.go', oldText: 'header\r\nbefore\r\nfooter\r\n',
    newText: 'header\nafter\nfooter\n' }]);
  assert.deepEqual(files, [{ path: 'fixture.go', linesAdded: 1, linesRemoved: 1, diff: '-before\n+after' }]);
  assert.deepEqual(confirmedUpdateChanges([{ type: 'diff', path: 'empty.txt', oldText: '', newText: '' }]), []);
});

test('malformed, sensitive, traversing and excessive native diff inputs never become file changes', () => {
  assert.deepEqual(confirmedUpdateChanges(undefined), []);
  const paths = ['', '.env', '../private.txt', 'folder\\private.txt', 'bad\npath', 'a'.repeat(2049)];
  const bad = paths.map(path => ({ type: 'diff', path, oldText: 'a', newText: 'b' }));
  bad.push({ type: 'diff', path: 'large.txt', oldText: 'x'.repeat(1_048_577), newText: '' });
  assert.deepEqual(confirmedUpdateChanges([...bad, null, {}, { type: 'text' }, { type: 'diff', path: 'x', oldText: null, newText: 'x' }]), []);
});

test('native diff previews have explicit truncation and a bounded file list', () => {
  const changes = confirmedUpdateChanges(Array.from({ length: 70 }, (_, index) => ({ type: 'diff', path: `fixture-${index}.txt`,
    oldText: '', newText: 'x'.repeat(20_000) })));
  assert.equal(changes.length, 64);
  assert.equal(changes[0]!.diff.length, 16_384);
  assert.equal(changes[0]!.diffTruncated, true);
});
