import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { grokTimeline } from '..';

function directory(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'granttap-native-clock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('native clock headers cross large snapshots without taking nested decoy clocks', t => {
  const root = directory(t), at = '2026-10-25T11:00:00Z';
  const rows = [
    { prompt_index: 0, created_at: at, file_snapshots: { content: 'x'.repeat(180_000) } },
    { file_snapshots: { prompt_index: 90, created_at: at } },
    { prompt_index: 1, created_at: at, file_snapshots: {} },
  ];
  writeFileSync(join(root, 'rewind_points.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
  assert.deepEqual([...grokTimeline(root).prompts], [[0, Date.parse(at)], [1, Date.parse(at)]]);
});

test('invalid native identities and clocks cannot become conversation timestamps', t => {
  const root = directory(t);
  writeFileSync(join(root, 'rewind_points.jsonl'), [
    '', 'not json', JSON.stringify({ prompt_index: -1, created_at: '2026-10-25T11:00:00Z' }),
    JSON.stringify({ prompt_index: 0.5, created_at: '2026-10-25T11:00:00Z' }),
    JSON.stringify({ prompt_index: 1, created_at: 'not a clock' }),
    JSON.stringify({ prompt_index: 2, created_at: '1960-01-01T00:00:00Z' }),
    JSON.stringify({ prompt_index: 9007199254740992, created_at: '2026-10-25T11:00:00Z' }),
  ].join('\n'));
  assert.equal(grokTimeline(root).prompts.size, 0);
});

test('replacing a native clock journal refreshes retained prompt timestamps', t => {
  const root = directory(t), path = join(root, 'rewind_points.jsonl');
  const row = (time: string) => JSON.stringify({ prompt_index: 1, created_at: time });
  const first = '2026-10-25T11:00:00Z', second = '2026-10-25T12:00:00Z';
  writeFileSync(path, row(first));
  assert.equal(grokTimeline(root).prompts.get(1), Date.parse(first));
  assert.equal(grokTimeline(root).prompts.get(1), Date.parse(first));
  const stat = statSync(path), replacement = join(root, 'replacement');
  writeFileSync(replacement, row(second));
  utimesSync(replacement, stat.atime, stat.mtime);
  renameSync(replacement, path);
  assert.equal(grokTimeline(root).prompts.get(1), Date.parse(second));
});

test('native completion is bounded to the latest turn and stops at a newer start', t => {
  const root = directory(t), path = join(root, 'events.jsonl'), at = '2026-10-25T12:00:00Z';
  const ended = JSON.stringify({ type: 'turn_ended', outcome: 'completed', ts: at });
  writeFileSync(path, 'x'.repeat(180_000) + '\n' + ended + '\n');
  assert.equal(grokTimeline(root).completedAt, Date.parse(at));
  writeFileSync(path, ended + '\n' + JSON.stringify({ type: 'turn_started', ts: at }) + '\n');
  assert.equal(grokTimeline(root).completedAt, undefined);
});

test('failed and unreadable native ends never confirm a final answer', t => {
  const root = directory(t), path = join(root, 'events.jsonl');
  for (const row of [
    { type: 'turn_ended', outcome: 'error', ts: '2026-10-25T12:00:00Z' },
    { type: 'turn_ended', outcome: 'completed', ts: 'invalid' },
    { type: 'turn_ended', outcome: 'completed', ts: 10 },
    { type: 'phase_changed', phase: 'streaming_text' },
  ]) {
    writeFileSync(path, JSON.stringify(row) + '\ninvalid tail\n');
    assert.equal(grokTimeline(root).completedAt, undefined);
  }
  writeFileSync(path, '');
  assert.equal(grokTimeline(root).completedAt, undefined);
});

test('missing or unavailable native files keep the timeline unknown', t => {
  const root = directory(t);
  assert.deepEqual([...grokTimeline(root).prompts], []);
  assert.equal(grokTimeline(root).completedAt, undefined);
  mkdirSync(join(root, 'rewind_points.jsonl'));
  mkdirSync(join(root, 'events.jsonl'));
  assert.equal(grokTimeline(root).prompts.size, 0);
  assert.equal(grokTimeline(root).completedAt, undefined);
});
