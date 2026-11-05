import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCodexSession, deliverToSession } from '../..';

test('a task created outside Git can receive a follow-up in the same persisted Codex session', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'granttap-codex-workspace-')));
  const binary = join(root, 'codex.mjs');
  const journal = join(root, 'turns.json');
  await writeFile(binary, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (!existsSync('.git') && !args.includes('--skip-git-repo-check')) {
  console.error('Not inside a trusted directory and --skip-git-repo-check was not specified.');
  process.exit(1);
}
const text = readFileSync(0, 'utf8');
const turns = existsSync('turns.json') ? JSON.parse(readFileSync('turns.json', 'utf8')) : [];
turns.push({sessionId:'fixture-task', text, cwd:process.cwd()});
writeFileSync('turns.json', JSON.stringify(turns));
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-task'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Turn '+turns.length}}));
`, { mode: 0o755 });
  const previous = process.env.GRANTTAP_CODEX_BIN;
  process.env.GRANTTAP_CODEX_BIN = binary;
  t.after(() => previous == null ? delete process.env.GRANTTAP_CODEX_BIN : process.env.GRANTTAP_CODEX_BIN = previous);
  const created = await createCodexSession('First turn', root, 5_000);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const resumed = await deliverToSession({ sessionId: created.sessionId!, agent: 'codex', cwd: root,
    state: 'idle', startedAt: 1, lastActivityAt: 1, tokensSession: 0, tokensLastTurn: 0 }, 'Follow-up', 5_000);
  assert.deepEqual(resumed, { ok: true, text: 'Turn 2', sessionId: created.sessionId });
  assert.deepEqual(JSON.parse(await readFile(journal, 'utf8')), [
    { sessionId: created.sessionId, text: 'First turn', cwd: root },
    { sessionId: created.sessionId, text: 'Follow-up', cwd: root },
  ]);
});
