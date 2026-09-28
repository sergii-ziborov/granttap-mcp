import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderStorage } from '../index';

async function fixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'granttap-provider-storage-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, '.codex');
  await mkdir(join(root, 'cache'), { recursive: true });
  await writeFile(join(root, 'cache', 'generated'), 'cache');
  await writeFile(join(root, 'session.jsonl'), 'history');
  const stores = [{ title: 'AI codex', path: root, logical_bytes: 12, capped: false, entries: [
    { id: 10, relative: 'cache', class: 'Cache', logical_bytes: 5, can_clean: true },
    { id: 11, relative: 'session.jsonl', class: 'History', logical_bytes: 7, can_clean: false },
  ] }];
  let sessions: unknown[] = [];
  const storage = new ProviderStorage({ home, call: async (tool: string) =>
    tool === 'list_ai_stores' ? stores : sessions });
  return { home, root, stores, storage, busy: () => { sessions = [{ kind: 'Codex', processes: 1 }]; } };
}

test('inspection protects history and confirmed cleanup moves only the reviewed cache to Trash', async t => {
  const f = await fixture(t);
  const report = await f.storage.read({ action: 'inspect' }) as any;
  assert.equal(report.available, true);
  const rows = report.stores[0].entries;
  assert.equal(rows[0].cleanable, true);
  assert.equal(rows[1].cleanable, false);
  const request = { action: 'trash', planId: report.planId, ids: JSON.stringify([rows[0].id]) };
  await assert.rejects(f.storage.read(request));
  await assert.rejects(f.storage.read({ ...request, confirm: 'true', ids: JSON.stringify([rows[1].id]) }));
  const applied = await f.storage.read({ ...request, confirm: 'true' }) as any;
  assert.equal(applied.moved, 1);
  assert.equal(await readFile(join(f.root, 'session.jsonl'), 'utf8'), 'history');
  const trash = await readdir(join(f.home, '.Trash'));
  assert.equal(trash.length, 1);
  assert.equal(await readFile(join(f.home, '.Trash', trash[0]!, 'generated'), 'utf8'), 'cache');
  await assert.rejects(f.storage.read({ ...request, confirm: 'true' }));
});

test('changed, running, expired and symlinked stores cannot be cleaned', async t => {
  const f = await fixture(t);
  let report = await f.storage.read({ action: 'inspect' }) as any;
  const clean = () => f.storage.read({ action: 'trash', confirm: 'true', planId: report.planId,
    ids: JSON.stringify([report.stores[0].entries[0].id]) });
  await writeFile(join(f.root, 'cache', 'generated'), 'changed contents');
  await assert.rejects(clean());
  report = await f.storage.read({ action: 'inspect' }) as any;
  f.busy();
  await assert.rejects(clean());
  const busy = await f.storage.read({ action: 'inspect' }) as any;
  assert.equal(busy.stores[0].entries[0].cleanable, false);
  await symlink(join(f.root, 'session.jsonl'), join(f.root, 'cache', 'link'));
  const symlinks = new ProviderStorage({ home: f.home, call: async (tool: string) =>
    tool === 'list_ai_stores' ? f.stores : [] });
  const scanned = await symlinks.read({ action: 'inspect' }) as any;
  assert.equal(scanned.stores[0].entries[0].cleanable, false);
  const expired = new ProviderStorage({ home: f.home, now: () => 0, call: async (tool: string) =>
    tool === 'list_ai_stores' ? f.stores : [] });
  await assert.rejects(expired.read({ action: 'trash', confirm: 'true', planId: 'unknown', ids: '[]' }));
});

test('unavailable scanner and invalid metadata remain inspect-only', async t => {
  const f = await fixture(t);
  const missing = new ProviderStorage({ home: f.home, call: async () => { throw new Error('unavailable'); } });
  assert.equal((await missing.read({ action: 'inspect' }) as any).available, false);
  await assert.rejects(missing.read({ action: 'unknown' }));
  await assert.rejects(missing.read(null));
  f.stores[0]!.path = join(f.home, 'outside');
  f.stores[0]!.entries[0]!.relative = '../session.jsonl';
  const report = await f.storage.read({ action: 'inspect' }) as any;
  assert.equal(report.stores.length, 0);
});


test('review expiry and a redirected Trash prevent any move', async t => {
  const f = await fixture(t);
  let now = 0;
  const storage = new ProviderStorage({ home: f.home, now: () => now, call: async (tool: string) =>
    tool === 'list_ai_stores' ? f.stores : [] });
  let report = await storage.read({ action: 'inspect' }) as any;
  const clean = () => storage.read({ action: 'trash', confirm: 'true', planId: report.planId,
    ids: JSON.stringify([report.stores[0].entries[0].id]) });
  now = 300001;
  await assert.rejects(clean());
  report = await storage.read({ action: 'inspect' }) as any;
  const elsewhere = join(f.home, 'redirected');
  await mkdir(elsewhere);
  await symlink(elsewhere, join(f.home, '.Trash'));
  await assert.rejects(clean());
  assert.equal(await readFile(join(f.root, 'cache', 'generated'), 'utf8'), 'cache');
  assert.deepEqual(await readdir(elsewhere), []);
});
