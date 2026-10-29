import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { binaryVersion, versionFromLayout } from '../version';

test('installed Grok download reports its own version without launching the executable', () => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-installed-version-'));
  try {
    const binary = join(root, '.grok/downloads/grok-1.0.70-macos-aarch64');
    const link = join(root, '.grok/bin/grok');
    mkdirSync(dirname(binary), { recursive: true });
    mkdirSync(dirname(link), { recursive: true });
    writeFileSync(binary, '#!/bin/sh\nexit 99\n'); chmodSync(binary, 0o755);
    symlinkSync(binary, link);
    assert.equal(binaryVersion(link, () => { throw Error('status must not start Grok'); }), '1.0.70');
    assert.equal(versionFromLayout('/tmp/.grok/downloads/grok-1.2.3-beta.4-linux-x86_64'), '1.2.3-beta.4');
    assert.equal(versionFromLayout('/tmp/.grok/downloads/grok-macos-aarch64'), undefined);
    assert.equal(versionFromLayout('/tmp/1.2.3/grok'), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('bundled Codex reads its own package version and retains prerelease precision', () => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-codex-version-'));
  const bundle = join(root, 'ChatGPT.app/Contents/Resources/codex-cli');
  const binary = join(bundle, 'CodexCLI.app/Contents/MacOS/codex');
  try {
    mkdirSync(dirname(binary), { recursive: true });
    writeFileSync(binary, '#!/bin/sh\nexit 99\n'); chmodSync(binary, 0o755);
    const manifest = join(bundle, 'codex-package.json');
    writeFileSync(manifest, JSON.stringify({ layoutVersion: 1, variant: 'codex', version: '0.165.0-alpha.1.2' }));
    assert.equal(binaryVersion(binary, () => { throw Error('status must not start Codex'); }), '0.165.0-alpha.1.2');
    for (const data of [
      { layoutVersion: 2, variant: 'codex', version: '9.9.9' },
      { layoutVersion: 1, variant: 'another-tool', version: '9.9.9' },
      { layoutVersion: 1, variant: 'codex', version: 'garbage 9.9.9' },
      { layoutVersion: 1, variant: 'codex', version: 123 },
    ]) {
      writeFileSync(manifest, JSON.stringify(data));
      assert.equal(binaryVersion(binary), undefined);
    }
    writeFileSync(manifest, 'broken json');
    assert.equal(binaryVersion(binary), undefined);
    rmSync(manifest);
    assert.equal(binaryVersion(binary), undefined);
    assert.equal(binaryVersion(join(root, 'missing-codex')), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
