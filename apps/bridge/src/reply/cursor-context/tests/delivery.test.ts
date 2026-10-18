import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { deliverToSession } from '../../index';

test('a phone continuation of an IDE task passes retained history to the real child process', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'granttap-cursor-retain-')));
  const db = join(root, 'state.vscdb'), transcripts = join(root, 'projects');
  const sessionId = 'ide-existing', folder = join(transcripts, 'fixture', 'agent-transcripts', sessionId);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, sessionId + '.jsonl'), [
    { role: 'user', message: { content: 'Keep authentication unchanged.' } },
    { role: 'assistant', message: { content: 'I will retain that constraint.' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const metadata = JSON.stringify({ composerId: sessionId, name: 'Fixture IDE task', status: 'completed',
    createdAt: 1, lastUpdatedAt: 2, workspaceIdentifier: { uri: { fsPath: root } } });
  execFileSync('sqlite3', [db, "CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value TEXT);"
    + `INSERT INTO cursorDiskKV VALUES('composerData:${sessionId}','${metadata.replace(/'/g, "''")}');`]);
  const bin = join(root, 'cursor.cjs');
  await writeFile(bin, `#!/usr/bin/env node
const args=process.argv.slice(2), fs=require('node:fs');
const body=fs.readFileSync(0,'utf8') || args.at(-1);
if (!body.includes('Keep authentication unchanged.') && body!=='Second') process.exit(3);
process.stdout.write(JSON.stringify({result:'Context retained',session_id:'ide-existing'}));
`, { mode: 0o755 });
  const env = { GRANTTAP_CONFIG_DIR: join(root, 'granttap'), GRANTTAP_CURSOR_STATE_DB: db,
    GRANTTAP_CURSOR_TRANSCRIPTS_DIR: transcripts, GRANTTAP_CURSOR_AGENT_BIN: bin };
  const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(async () => { for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } await rm(root, { recursive: true, force: true }); });
  const session = { sessionId, agent: 'cursor' as const, cwd: root, state: 'idle' as const,
    startedAt: 1, lastActivityAt: 2, tokensSession: 0, tokensLastTurn: 0 };
  assert.deepEqual(await deliverToSession(session, 'Continue', 5_000),
    { ok: true, text: 'Context retained', sessionId });
  assert.deepEqual(await deliverToSession(session, 'Second', 5_000),
    { ok: true, text: 'Context retained', sessionId });
});
