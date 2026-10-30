import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { codexLogLines, codexLogPathBySession } from '..';

test('unknown rollouts inspect bounded identities once; a matching chat still returns its full activity', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'granttap-rollout-lookup-'));
  const file = join(root, 'rollout-foreign.jsonl');
  const foreign = 'lookup-foreign', missing = 'lookup-unavailable';
  const rows = [JSON.stringify({ type: 'session_meta', payload: { id: foreign } }),
    JSON.stringify({ type: 'response_item', payload: { output: 'x'.repeat(8 * 1024 * 1024) } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'Matching chat result' } })];
  fs.writeFileSync(file, rows.join('\n') + '\n');
  const previous = process.env.GRANTTAP_CODEX_SESSIONS_DIR;
  process.env.GRANTTAP_CODEX_SESSIONS_DIR = root;
  let bytes = 0;
  const readFile = fs.readFileSync, read = fs.readSync;
  t.mock.method(fs, 'readFileSync', (path: fs.PathOrFileDescriptor, options: any) => {
    const value = readFile(path, options);
    if (path === file) bytes += Buffer.byteLength(value);
    return value;
  });
  t.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => {
    const count = read(...args); bytes += count; return count;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    if (previous === undefined) delete process.env.GRANTTAP_CODEX_SESSIONS_DIR;
    else process.env.GRANTTAP_CODEX_SESSIONS_DIR = previous;
    codexLogPathBySession.delete(foreign);
    codexLogPathBySession.delete(missing);
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.equal(codexLogLines(missing), undefined);
  assert.ok(bytes <= 1024 * 1024, `A missing chat must not read another chat's ${bytes} bytes of activity`);
  bytes = 0;
  assert.equal(codexLogLines(missing), undefined);
  assert.equal(bytes, 0, 'Unchanged identities must not be reread for the next missing chat lookup');
  const lines = codexLogLines(foreign);
  assert.ok(lines?.some(line => line.includes('Matching chat result')));
  assert.ok(bytes > 8 * 1024 * 1024, 'The requested chat retains the original activity window');
});
