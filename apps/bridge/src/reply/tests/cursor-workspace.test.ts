import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCursorSession, deliverToSession } from '..';

test('explicit Cursor turns trust only their selected workspace and retain tool approval', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'granttap-cursor-workspace-')));
  const bin = join(root, 'cursor.mjs');
  await writeFile(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (!args.includes('--trust')) { console.error('Workspace Trust Required'); process.exit(1); }
if (args.some(a => ['--force', '--yolo', '-f', '--approve-mcps'].includes(a))) process.exit(2);
process.stdout.write(JSON.stringify({ result: process.cwd(), session_id: args.includes('--resume') ? args[args.indexOf('--resume')+1] : 'new-cursor-chat' }));
`, { mode: 0o755 });
  const prior = { bin: process.env.GRANTTAP_CURSOR_AGENT_BIN, root: process.env.GRANTTAP_CONFIG_DIR };
  process.env.GRANTTAP_CURSOR_AGENT_BIN = bin;
  process.env.GRANTTAP_CONFIG_DIR = join(root, 'config');
  t.after(async () => {
    for (const [key, value] of [['GRANTTAP_CURSOR_AGENT_BIN', prior.bin], ['GRANTTAP_CONFIG_DIR', prior.root]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const created = await createCursorSession('Synthetic new task', root, 5_000);
  assert.deepEqual(created, { ok: true, text: root, sessionId: 'new-cursor-chat' });
  const resumed = await deliverToSession({ sessionId: 'cursor-existing', agent: 'cursor', cwd: root,
    state: 'idle', startedAt: 1, lastActivityAt: 1, tokensSession: 0, tokensLastTurn: 0 },
  'Synthetic continuation', 5_000);
  assert.deepEqual(resumed, { ok: true, text: root, sessionId: 'cursor-existing' });
  const unknownWorkspace = await deliverToSession({ sessionId: 'cursor-unscoped', agent: 'cursor',
    state: 'idle', startedAt: 1, lastActivityAt: 1, tokensSession: 0, tokensLastTurn: 0 }, 'Continue', 5_000);
  assert.equal(unknownWorkspace.ok, false, 'never trust the monitor home as an implicit workspace');
});
