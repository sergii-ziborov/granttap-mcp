import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const root = join(import.meta.dirname, '../..');

test('phone add and reconnect reach the privacy guard through the published launcher and direct entry', t => {
  const directory = mkdtempSync(join(tmpdir(), 'granttap-phone-argv-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const mode of ['add', 'reconnect']) {
    const entry = join(root, 'apps/bridge/src/bin/cli/phone.ts');
    const cases = [
      [join(root, 'bin/granttap-mcp.mjs'), 'phone', mode],
      ['--import', 'tsx', entry, 'phone', mode],
      ['--import', 'tsx', entry, mode],
    ];
    for (const args of cases) {
      const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 20_000,
        env: { ...process.env, GRANTTAP_CONFIG_DIR: directory, NODVOX_CONFIG_DIR: directory } });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /interactive terminal/, `The ${mode} mode must survive argument forwarding: ${result.stderr}`);
      assert.doesNotMatch(result.stderr, /Usage: granttap phone/);
      assert.equal(result.stdout, '', 'A private pairing QR must never enter the non-interactive test output.');
    }
  }
  assert.deepEqual(readdirSync(directory), [], 'Argument verification must not alter pairing state.');
});
