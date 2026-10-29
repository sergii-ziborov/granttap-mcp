import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { grokActivity, scanGrok } from '../../../sessions/scan/grok';

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(join(tmpdir(), 'granttap-grok-cache-'));
  const directory = join(root, 'project', 'cache-native'); fs.mkdirSync(directory, { recursive: true });
  const previous = process.env.GRANTTAP_GROK_SESSIONS_DIR; process.env.GRANTTAP_GROK_SESSIONS_DIR = root;
  const now = Date.now(), history = join(directory, 'chat_history.jsonl');
  fs.writeFileSync(join(directory, 'summary.json'), JSON.stringify({ info: { id: 'cache-native' },
    created_at: new Date(now - 10_000).toISOString(), updated_at: new Date(now).toISOString() }));
  const row = (role: string, content: string) => JSON.stringify({ role, content, timestamp: new Date(now).toISOString() }) + '\n';
  fs.writeFileSync(history, row('user', 'First fixture request') + row('assistant', 'A'.repeat(8000)));
  const original = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', ((path: any, options: any) => {
    if (String(path) === history) reads++;
    return original(path, options);
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    if (previous === undefined) delete process.env.GRANTTAP_GROK_SESSIONS_DIR;
    else process.env.GRANTTAP_GROK_SESSIONS_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, directory, history, row, reads: () => reads };
}

test('an unchanged Grok catalog reuses observed context while full capture still reads the complete source', t => {
  const f = fixture(t);
  const first = scanGrok().sessions[0]!; assert.equal(f.reads(), 1);
  const second = scanGrok().sessions[0]!;
  assert.equal(f.reads(), 1, 'A status refresh must not decode the same context file again');
  assert.equal(second.tokensSession, first.tokensSession);
  assert.ok(grokActivity(second, true).some(row => row.text === 'A'.repeat(8000)));
  assert.equal(f.reads(), 2, 'Explicit complete capture must bypass the catalog cache');
  scanGrok(); assert.equal(f.reads(), 2);
});

test('new visible updates do not require decoding unchanged model context', t => {
  const f = fixture(t); scanGrok();
  const update = (text: string) => JSON.stringify({ timestamp: Date.now(), method: 'session/update',
    params: { sessionId: 'cache-native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } }) + '\n';
  const updates = join(f.directory, 'updates.jsonl'); fs.writeFileSync(updates, update('Native answer'));
  let session = scanGrok().sessions[0]!;
  assert.ok(grokActivity(session).some(row => row.text === 'Native answer'));
  assert.equal(f.reads(), 1);
  fs.appendFileSync(updates, update(' fresh'));
  session = scanGrok().sessions[0]!;
  assert.ok(grokActivity(session).some(row => row.text.includes('fresh')));
  assert.equal(f.reads(), 1);
});

test('advancing the native reader cannot mutate a previously published conversation snapshot', t => {
  const f = fixture(t), updates = join(f.directory, 'updates.jsonl');
  const row = (text: string) => JSON.stringify({ timestamp: Date.now(), method: 'session/update', params: {
    sessionId: 'cache-native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  } }) + '\n';
  fs.writeFileSync(updates, row('Initial answer'));
  const before = grokActivity(scanGrok().sessions[0]!);
  fs.appendFileSync(updates, row(' continued'));
  const after = grokActivity(scanGrok().sessions[0]!);
  assert.equal(after[0]?.text, 'Initial answer continued');
  assert.equal(before[0]?.text, 'Initial answer');
});

test('a legacy-only complete export refuses an unfinished record instead of silently losing it', t => {
  const f = fixture(t), session = scanGrok().sessions[0]!;
  fs.appendFileSync(f.history, '{"role":"assistant","content":"unfinished');
  assert.throws(() => grokActivity(session, true), /complete|written|incomplete/i);
});

test('append, same-size rewrites and atomic replacement invalidate only the changed source', t => {
  const f = fixture(t); scanGrok();
  fs.appendFileSync(f.history, f.row('assistant', 'New native fact'));
  let session = scanGrok().sessions[0]!;
  assert.equal(f.reads(), 2); assert.ok(grokActivity(session).some(row => row.text === 'New native fact'));
  const stat = fs.statSync(f.history), content = fs.readFileSync(f.history, 'utf8');
  fs.writeFileSync(f.history, content.replace('First fixture', 'Other fixture')); fs.utimesSync(f.history, stat.atime, stat.mtime);
  session = scanGrok().sessions[0]!; assert.equal(session.title, 'Other fixture request');
  const replacement = join(f.directory, 'replacement'); fs.writeFileSync(replacement, content);
  fs.utimesSync(replacement, stat.atime, stat.mtime); fs.renameSync(replacement, f.history);
  session = scanGrok().sessions[0]!; assert.equal(session.title, 'First fixture request');
});

test('switching roots cannot export a cached conversation belonging to the previous source', t => {
  const f = fixture(t), old = scanGrok().sessions[0]!;
  const other = join(f.root, 'other-root'); fs.mkdirSync(other);
  process.env.GRANTTAP_GROK_SESSIONS_DIR = other;
  assert.deepEqual(scanGrok().sessions, []);
  assert.deepEqual(grokActivity(old, true), []);
});

test('an empty native stream stays authoritative and deleting it restores the legacy source', t => {
  const f = fixture(t), updates = join(f.directory, 'updates.jsonl');
  fs.writeFileSync(updates, '');
  let session = scanGrok().sessions[0]!;
  assert.deepEqual(grokActivity(session), []);
  scanGrok(); assert.equal(f.reads(), 1);
  fs.rmSync(updates);
  session = scanGrok().sessions[0]!;
  assert.equal(f.reads(), 2);
  assert.ok(grokActivity(session).some(row => row.kind === 'user'));
});

test('native event completion invalidates cached context without inventing another user request', t => {
  const f = fixture(t), baseline = scanGrok().sessions[0]!;
  const before = grokActivity(baseline).map(row => row.id), completed = Date.now() + 1000;
  fs.writeFileSync(f.history, JSON.stringify({ type: 'user', prompt_index: 0, content: 'Fixture request' }) + '\n'
    + JSON.stringify({ type: 'assistant', content: 'Fixture answer' }) + '\n');
  const first = grokActivity(scanGrok().sessions[0]!);
  const at = Date.now() - 1000;
  fs.writeFileSync(join(f.directory, 'rewind_points.jsonl'), JSON.stringify({ prompt_index: 0, created_at: new Date(at).toISOString() }) + '\n');
  fs.writeFileSync(join(f.directory, 'events.jsonl'), JSON.stringify({ type: 'turn_ended', outcome: 'completed', ts: new Date(completed).toISOString() }) + '\n');
  const updated = grokActivity(scanGrok().sessions[0]!);
  assert.deepEqual(updated.map(row => row.id), first.map(row => row.id));
  assert.equal(updated[0]?.createdAt, at); assert.equal(updated.at(-1)?.kind, 'final');
  assert.equal(updated.at(-1)?.createdAt, completed); assert.equal(updated.filter(row => row.kind === 'user').length, 1);
  assert.equal(before.length, 2);
});

test('a temporary context read failure is retried even when the file fingerprint did not change', t => {
  const f = fixture(t), original = fs.readFileSync;
  let failed = false;
  t.mock.method(fs, 'readFileSync', ((path: any, options: any) => {
    if (!failed && String(path) === f.history) { failed = true; throw Object.assign(Error('Fixture descriptor limit'), { code: 'EMFILE' }); }
    return original(path, options);
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  assert.equal(scanGrok().sessions[0]?.tokensSession, 0);
  const recovered = scanGrok().sessions[0]!;
  assert.ok(recovered.tokensSession > 0);
  assert.ok(grokActivity(recovered).some(row => row.kind === 'user'));
});
