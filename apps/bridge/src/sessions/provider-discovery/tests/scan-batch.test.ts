import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { scanSessionsCooperatively, scanSessionHistoryCooperatively } from '../..';

test('concurrent live and history consumers share a native provider scan, while the next refresh is fresh', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-provider-batch-'));
  const original = join(root, 'original'), observed = join(root, 'observed');
  const logs = join(root, 'logs'), bin = join(root, 'bin'), calls = join(root, 'calls');
  for (const path of [original, observed, logs, bin]) mkdirSync(path);
  for (const path of [original, observed]) execFileSync('/usr/bin/git', ['init', '-q', path]);
  const previous = { path: process.env.PATH, logs: process.env.GRANTTAP_CODEX_SESSIONS_DIR };
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf x >> '${calls}'\nexec /usr/bin/git "$@"\n`, { mode: 0o700 });
  process.env.PATH = `${bin}:${previous.path}`; process.env.GRANTTAP_CODEX_SESSIONS_DIR = logs;
  t.after(() => {
    process.env.PATH = previous.path;
    if (previous.logs === undefined) delete process.env.GRANTTAP_CODEX_SESSIONS_DIR;
    else process.env.GRANTTAP_CODEX_SESSIONS_DIR = previous.logs;
    rmSync(root, { recursive: true, force: true });
  });
  let rootReads = 0;
  const readDirectory = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (path: fs.PathLike, options: any) => {
    if (path === logs) rootReads++; return readDirectory(path, options);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const write = (revision: number) => {
    for (let index = 0; index < 3; index++) {
      const rows = [{ type: 'session_meta', payload: { id: `batch-${index}`, cwd: original } },
        ...Array.from({ length: 3 }, (_, call) => ({ type: 'response_item', payload: {
          type: 'function_call', name: 'exec_command', call_id: `call-${revision}-${call}`,
          arguments: JSON.stringify({ cmd: 'pwd', workdir: observed }) } }))];
      writeFileSync(join(logs, `rollout-${index}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    }
  };
  write(0);
  const [live, history] = await Promise.all([scanSessionsCooperatively(), scanSessionHistoryCooperatively()]);
  assert.equal(rootReads, 1, 'Concurrent consumers must discover the same native directory once');
  assert.equal(live.sessions.length, 3); assert.equal(history.length, 3);
  assert.ok([...live.sessions, ...history].every(s => s.worktree === realpathSync(observed)));
  assert.equal(readFileSync(calls, 'utf8').length, 2, 'Connections must not duplicate the same native checkout verification');
  write(1);
  const fresh = await scanSessionsCooperatively(); assert.equal(fresh.sessions.length, 3);
  assert.equal(rootReads, 2, 'A later request performs a fresh directory observation');
  assert.equal(readFileSync(calls, 'utf8').length, 4, 'A later scan still verifies the current native state');
});
