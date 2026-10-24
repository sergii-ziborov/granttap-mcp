import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { scanGrok } from '../grok';
import { runGrokResume } from '../../../reply/process/provider-headless';

test('a native Grok turn stays busy between summary writes and cannot be resumed concurrently', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-grok-live-'));
  const directory = join(root, 'sessions', encodeURIComponent(root), 'native');
  mkdirSync(directory, { recursive: true });
  const names = ['GRANTTAP_GROK_DIR', 'GRANTTAP_GROK_SESSIONS_DIR', 'GRANTTAP_GROK_BIN'];
  const prior = names.map(key => process.env[key]);
  process.env.GRANTTAP_GROK_DIR = root; process.env.GRANTTAP_GROK_SESSIONS_DIR = join(root, 'sessions');
  const marker = join(root, 'started'), bin = join(root, 'grok');
  writeFileSync(bin, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');\n`, { mode: 0o755 });
  process.env.GRANTTAP_GROK_BIN = bin;
  t.after(() => { names.forEach((key, i) => { if (prior[i] == null) delete process.env[key]; else process.env[key] = prior[i]; });
    rmSync(root, { recursive: true, force: true }); });
  const start = Date.parse(execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='],
    { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim());
  writeFileSync(join(root, 'active_sessions.json'), JSON.stringify([
    { session_id: 'native', pid: process.pid, pid_start: start * 1_000, cwd: root },
  ]));
  const old = Date.now() - 86_400_000, now = new Date().toISOString();
  writeFileSync(join(directory, 'summary.json'), JSON.stringify({ info: { id: 'native', cwd: root },
    updated_at: new Date(old).toISOString(), generated_title: 'Fixture' }));
  writeFileSync(join(directory, 'events.jsonl'), 'x'.repeat(300_000) + '\n'
    + JSON.stringify({ type: 'phase_changed', phase: 'waiting_for_model', ts: now }) + '\n');
  let session = scanGrok().sessions[0]!;
  assert.equal(session.state, 'working');
  assert.ok(session.lastActivityAt > old);
  const refused = await runGrokResume(session, 'Synthetic check', 1_000);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /still running/);
  const { existsSync } = await import('node:fs'); assert.equal(existsSync(marker), false);
  writeFileSync(join(directory, 'events.jsonl'), JSON.stringify({ type: 'phase_changed', phase: 'permission_prompt', ts: now }) + '\n');
  session = scanGrok().sessions[0]!; assert.equal(session.state, 'waiting');
  writeFileSync(join(directory, 'events.jsonl'), JSON.stringify({ type: 'turn_ended', outcome: 'success', ts: now }) + '\n');
  assert.equal(scanGrok().sessions[0]!.state, 'idle');
});
