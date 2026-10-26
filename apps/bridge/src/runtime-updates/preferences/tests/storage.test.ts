import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automaticUpdateSettings, automaticUpdatesAllowed, saveAutomaticUpdateSetting } from '../storage.mjs';

test('preferences default on without creating files and reject invalid stored values', () => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-update-storage-'));
  assert.deepEqual(automaticUpdateSettings(root), { enabled: true, lockedByEnvironment: false });
  assert.deepEqual(readdirSync(root), []);
  for (const contents of ['null', '{}', '{"automaticUpdatesEnabled":"true"}', 'invalid']) {
    writeFileSync(join(root, 'preferences.json'), contents);
    assert.equal(automaticUpdatesAllowed(root), false);
  }
});

test('explicit off/on persists and invalid writes preserve the last saved preference', () => {
  const root = join(mkdtempSync(join(tmpdir(), 'granttap-update-save-')), 'updates');
  saveAutomaticUpdateSetting(root, false); assert.equal(automaticUpdatesAllowed(root), false);
  const original = readFileSync(join(root, 'preferences.json'), 'utf8');
  assert.throws(() => saveAutomaticUpdateSetting(root, 'true' as unknown as boolean), TypeError);
  assert.equal(readFileSync(join(root, 'preferences.json'), 'utf8'), original);
  saveAutomaticUpdateSetting(root, true); assert.equal(automaticUpdatesAllowed(root), true);
  assert.deepEqual(readdirSync(root), ['preferences.json']);
});

test('failed replacement cleans its temporary file and unreadable preferences remain off', () => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-update-write-failure-'));
  mkdirSync(join(root, 'preferences.json'));
  assert.equal(automaticUpdatesAllowed(root), false);
  assert.throws(() => saveAutomaticUpdateSetting(root, true));
  assert.deepEqual(readdirSync(root), ['preferences.json']);
});
