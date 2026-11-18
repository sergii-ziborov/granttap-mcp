import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLAUDE_MODEL_KEEP_MS, CLAUDE_MODEL_REFRESH_MS, cachedClaudeModels } from '../claude-model-cache';

/** A Claude Code that answers like 2.1.322 signed in, or fails, as its `mode` file says; each start is counted. */
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-claude-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, 'claude');
  writeFileSync(join(root, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'account-a' } }));
  writeFileSync(join(root, 'mode'), 'answer');
  writeFileSync(binary, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),root=${JSON.stringify(root)};
if(process.argv.includes('--version')){console.log('2.1.322');process.exit(0)}
fs.appendFileSync(path.join(root,'probes'),'x');
if(fs.readFileSync(path.join(root,'mode'),'utf8')==='fail'){process.stderr.write('Synthetic failure\\n');process.exit(3)}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:request.request_id,response:{models:[
  {value:'default',displayName:'Default (recommended)'},
  {value:'opus',displayName:'Opus 5.5',description:'For complex work and everyday tasks',supportedEffortLevels:['low','high']},
  {value:'sonnet',displayName:'Sonnet 5.5',description:'Most efficient for simpler tasks'},
  {value:'claude-opus-4-8',displayName:'Opus 4.8'}]}}}));
});`);
  chmodSync(binary, 0o700);
  const env = { PATH: dirname(process.execPath), GRANTTAP_CLAUDE_BIN: binary, GRANTTAP_CLAUDE_DIR: root };
  const probes = () => { try { return readFileSync(join(root, 'probes'), 'utf8').length; } catch { return 0; } };
  return { root, env, memory: join(root, 'memory.json'), probes, mode: (value: string) => writeFileSync(join(root, 'mode'), value) };
}

async function until(done: () => boolean, read: () => unknown) {
  const end = Date.now() + 5_000;
  while (!done() && Date.now() < end) { read(); await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.ok(done(), 'the picker query must settle');
}

const labels = (rows: Array<{ label?: string }>) => rows.map(row => row.label);
/** Long enough for a wrongly started fixture to have counted itself. */
const quiet = () => new Promise(resolve => setTimeout(resolve, 300));

test('one failed refresh keeps the answer, is retried after 15 s then every two minutes, and the answer outlives its refresh', async t => {
  const { root, env, memory, probes, mode } = fixture(t);
  let now = 1_000_000;
  const logged: string[] = [];
  const read = () => cachedClaudeModels('fixture-refresh', env, root, line => logged.push(line), { memory, now: () => now });
  await until(() => read()[0]?.label === 'Opus 5.5', () => {});
  const answeredAt = now;
  assert.deepEqual(labels(read()), ['Opus 5.5', 'Sonnet 5.5', 'Opus 4.8']);
  assert.equal(probes(), 1);
  const fallbacks = () => logged.filter(line => line.includes('offering its aliases')).length;
  const served = fallbacks();
  mode('fail');
  now = answeredAt + CLAUDE_MODEL_REFRESH_MS - 1;
  read(); await quiet();
  assert.equal(probes(), 1, 'a good answer is not asked again before ten minutes');
  now = answeredAt + CLAUDE_MODEL_REFRESH_MS;
  assert.deepEqual(labels(read()), ['Opus 5.5', 'Sonnet 5.5', 'Opus 4.8'], 'the refresh starts while the answer stays');
  await until(() => logged.some(line => line.includes('1 in a row')), read);
  assert.match(logged.find(line => line.includes('1 in a row'))!, /next in 15 s; its last answer stays offered\): exited with code 3 before answering: Synthetic failure$/);
  const failedAt = now;
  now = failedAt + 14_999; read(); await quiet();
  assert.equal(probes(), 2);
  now = failedAt + 15_000;
  await until(() => probes() === 3, read);
  await until(() => logged.some(line => line.includes('2 in a row, next in 120 s')), read);
  now = failedAt + 15_000 + 119_999; read(); await quiet();
  assert.equal(probes(), 3, 'no retry before two minutes');
  now = failedAt + 15_000 + 120_000;
  await until(() => probes() === 4, read);
  await until(() => logged.some(line => line.includes('3 in a row')), read);
  now = answeredAt + CLAUDE_MODEL_KEEP_MS;
  assert.deepEqual(labels(read()), ['Opus 5.5', 'Sonnet 5.5', 'Opus 4.8'], 'kept for an hour after it was given');
  assert.equal(fallbacks(), served, 'no fallback was served while the answer was kept');
  now = answeredAt + CLAUDE_MODEL_KEEP_MS + 1;
  const aliases = read();
  assert.deepEqual(aliases.map(row => row.modelId), ['opus', 'sonnet', 'haiku', 'fable']);
  assert.deepEqual(labels(aliases), ['Opus 5.5', 'Sonnet 5.5', 'Haiku', 'Fable'],
    'aliases carry the versions this Claude Code named; the ones it never named stay unversioned');
  assert.equal(aliases[0]!.description, 'For complex work and everyday tasks');
  assert.deepEqual(aliases[0]!.supportedEfforts, ['low', 'high']);
  assert.equal(aliases[2]!.description, 'Latest Haiku alias · fast, efficient simple tasks.');
  assert.match(logged.at(-1)!, /^Claude Code model list unavailable, offering its aliases as Opus 5\.5, Sonnet 5\.5, Haiku, Fable: its last answer is more than 60 min old; exited with code 3/);
  mode('answer');
  now += 120_000;
  await until(() => read().some(row => row.modelId === 'claude-opus-4-8'), () => {});
  assert.deepEqual(labels(read()), ['Opus 5.5', 'Sonnet 5.5', 'Opus 4.8'], 'the next answer replaces the aliases');
});

test('a restarted monitor offers the last answer at once, and another account never sees it', async t => {
  const { root, env, memory, probes, mode } = fixture(t);
  const read = () => cachedClaudeModels('fixture-restart', env, root, () => {}, { memory });
  await until(() => read()[0]?.label === 'Opus 5.5', () => {});
  const restart = () => {
    const module = fileURLToPath(new URL('../claude-model-cache.ts', import.meta.url));
    const source = `import { cachedClaudeModels } from ${JSON.stringify(module)};
const logged = [];
const rows = cachedClaudeModels('fixture-restart', ${JSON.stringify(env)}, ${JSON.stringify(root)}, line => logged.push(line),
  { memory: ${JSON.stringify(memory)} });
console.log(JSON.stringify({ labels: rows.map(row => row.label), logged }));
process.exit(0);`;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source],
      { encoding: 'utf8', timeout: 20_000 });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout.trim().split('\n').at(-1)!) as { labels: string[]; logged: string[] };
  };
  const restarted = restart();
  assert.deepEqual(restarted.labels, ['Opus 5.5', 'Sonnet 5.5', 'Opus 4.8'],
    'the first catalog after a restart is the CLI answer, not four unnamed aliases');
  assert.deepEqual(restarted.logged, []);
  await until(() => probes() >= 2, () => {});
  const saved = readFileSync(memory, 'utf8');
  assert.equal(saved.includes('account-a'), false, 'account fields are kept only as opaque digests');
  mode('fail');
  writeFileSync(join(root, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'account-b' } }));
  assert.deepEqual(labels(read()), ['Opus', 'Sonnet', 'Haiku', 'Fable'], 'another account inherits neither rows nor names');
  assert.deepEqual(restart().labels, ['Opus', 'Sonnet', 'Haiku', 'Fable']);
});

test('changed settings keep the answer until the new one arrives', async t => {
  const { root, env, memory, probes } = fixture(t);
  const logged: string[] = [];
  const read = () => cachedClaudeModels('fixture-settings', env, root, line => logged.push(line), { memory });
  await until(() => read()[0]?.label === 'Opus 5.5', () => {});
  const served = logged.length;
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ model: 'opus' }));
  assert.deepEqual(labels(read()), ['Opus 5.5', 'Sonnet 5.5', 'Opus 4.8']);
  await until(() => probes() === 2, read);
  assert.equal(logged.length, served, 'no unnamed aliases stood in');
  writeFileSync(join(root, '.claude.json'), '{"oauthAccount":{"accountUu');
  assert.deepEqual(labels(read()), ['Opus 5.5', 'Sonnet 5.5', 'Opus 4.8'],
    'a half-written .claude.json is the same account, not a new one');
  assert.equal(logged.length, served);
});

test('a kept answer that is unreadable or oversized is ignored', async t => {
  const { root, env, memory } = fixture(t);
  writeFileSync(memory, '{not json');
  assert.deepEqual(labels(cachedClaudeModels('fixture-bad-memory', env, root, () => {}, { memory })),
    ['Opus', 'Sonnet', 'Haiku', 'Fable']);
  writeFileSync(memory, JSON.stringify({ answers: [{ identity: 'x'.repeat(64), scope: 'y', rows: 'z'.repeat(300_000) }] }));
  assert.deepEqual(labels(cachedClaudeModels('fixture-big-memory', env, root, () => {}, { memory })),
    ['Opus', 'Sonnet', 'Haiku', 'Fable']);
});
