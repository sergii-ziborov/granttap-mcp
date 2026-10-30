import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { claudeAccountScope } from '../claude-account-scope';

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(join(tmpdir(), 'granttap-account-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('account scope ignores native startup/profile bookkeeping, keeps no raw account/key text, and detects model permissions', t => {
  const file = join(fixture(t), 'config.json');
  const account = { accountUuid: 'fixture-account', organizationUuid: 'fixture-organization', seatTier: 'tier-one' };
  const original = { oauthAccount: account, primaryApiKey: 'private-fixture-key', numStartups: 1 };
  fs.writeFileSync(file, JSON.stringify(original));
  const first = claudeAccountScope(file);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first.includes('private-fixture-key'), false);
  fs.writeFileSync(file, JSON.stringify({ ...original, numStartups: 2, theme: 'new',
    oauthAccount: { ...account, profileFetchedAt: Date.now(), displayName: 'Changed display name' } }));
  assert.equal(claudeAccountScope(file), first);
  assert.equal(claudeAccountScope(file), first);
  for (const change of [{ accountUuid: 'other-account' }, { organizationUuid: 'other-organization' },
    { seatTier: 'other-tier' }, { userRateLimitTier: 'other-limit' }]) {
    fs.writeFileSync(file, JSON.stringify({ ...original, oauthAccount: { ...account, ...change } }));
    assert.notEqual(claudeAccountScope(file), first);
  }
  fs.writeFileSync(file, JSON.stringify({ ...original, primaryApiKey: 'other-fixture-key' }));
  assert.notEqual(claudeAccountScope(file), first);
});

test('malformed, missing, oversized and non-file native metadata has a stable unavailable scope', t => {
  const root = fixture(t), file = join(root, 'config.json');
  assert.equal(claudeAccountScope(file), 'unavailable');
  fs.writeFileSync(file, '{broken'); assert.equal(claudeAccountScope(file), 'unavailable');
  fs.writeFileSync(file, 'x'.repeat(4 * 1024 * 1024 + 1)); assert.equal(claudeAccountScope(file), 'unavailable');
  assert.equal(claudeAccountScope(root), 'unavailable');
});

test('only a bounded set of unchanged file digests is retained and a concurrent replacement is reobserved', t => {
  const root = fixture(t), file = join(root, 'first');
  const write = (path: string, id: string) => fs.writeFileSync(path, JSON.stringify({ oauthAccount: { accountUuid: id } }));
  write(file, 'before'); const before = claudeAccountScope(file);
  let reads = 0, replace = false;
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (path: fs.PathOrFileDescriptor, options: any) => {
    const value = read(path, options);
    if (path === file) { reads++; if (replace) { replace = false; write(file, 'after'); } }
    return value;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(claudeAccountScope(file), before); assert.equal(reads, 0);
  for (let index = 0; index < 17; index++) {
    const other = join(root, String(index)); write(other, String(index)); claudeAccountScope(other);
  }
  replace = true;
  assert.equal(claudeAccountScope(file), before); assert.equal(reads, 1);
  assert.notEqual(claudeAccountScope(file), before); assert.equal(reads, 2);
});
