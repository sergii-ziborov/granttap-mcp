import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { EndpointModelCatalog } from '../../../../../../packages/protocol/schema';
import { cachedClaudeModels } from '../claude-model-cache';
import { readClaudeModels } from '../claude-models';

const ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];

function fixture(t: TestContext, body: string) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-claude-aliases-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, 'claude');
  writeFileSync(binary, `#!/usr/bin/env node\nif(process.argv.includes('--version')){console.log('2.1.296');process.exit(0)}\n${body}`);
  chmodSync(binary, 0o700);
  // Node runs the fixture; the explicit override is the only Claude Code this test installs.
  return { root, memory: join(root, 'memory.json'),
    env: { PATH: dirname(process.execPath), GRANTTAP_CLAUDE_BIN: binary, GRANTTAP_CLAUDE_DIR: root } };
}

async function settle(read: () => unknown, done: () => boolean) {
  const end = Date.now() + 5_000;
  while (!done() && Date.now() < end) { read(); await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.ok(done(), 'the picker query must settle');
}

test('an installed Claude Code whose picker query fails still advertises its aliases, and says so on every read', async t => {
  const { root, env, memory } = fixture(t, "process.stderr.write('Synthetic startup failure\\n');process.exit(3);");
  const logged: string[] = [];
  const read = () => cachedClaudeModels('fixture-alias-fallback', env, root, line => logged.push(line), { memory });
  assert.deepEqual(read().map(row => row.modelId), ALIASES, 'the phone has a list while the query runs');
  assert.deepEqual(logged, ['Claude Code model list unavailable, offering its aliases as Opus, Sonnet, Haiku, Fable: '
    + 'its first answer has not arrived']);
  await settle(read, () => logged.some(line => line.includes('query failed')));
  const rows = read();
  assert.deepEqual(rows.map(row => row.modelId), ALIASES);
  assert.deepEqual(rows.map(row => row.label), ['Opus', 'Sonnet', 'Haiku', 'Fable'],
    'no answer from this Claude Code and account: no version is invented');
  assert.deepEqual(rows.map(row => row.priority), [0, 1, 2, 3]);
  assert.ok(rows.every(row => row.provider === 'claude' && row.source === 'advertised'
    && row.endpointId === 'fixture-alias-fallback' && row.observedAt > 0 && row.label));
  assert.ok(EndpointModelCatalog.safeParse({ endpointId: 'fixture-alias-fallback', observedAt: 1, models: rows }).success);
  const failures = logged.filter(line => line.includes('query failed'));
  assert.equal(failures.length, 1, 'one failed query, one line');
  assert.match(failures[0]!, /1 in a row, next in 15 s\): exited with code 3 before answering: Synthetic startup failure$/);
  const served = logged.filter(line => line.includes('offering its aliases')).length;
  read(); read();
  assert.equal(logged.filter(line => line.includes('offering its aliases')).length, served + 2,
    'each catalog read that offers the aliases is one line');
  assert.match(logged.at(-1)!, /offering its aliases as Opus, Sonnet, Haiku, Fable: exited with code 3 before answering/);
});

test('a Mac without Claude Code advertises no Claude models and starts nothing', () => {
  const empty = mkdtempSync(join(tmpdir(), 'granttap-no-claude-'));
  try {
    const logged: string[] = [];
    assert.deepEqual(cachedClaudeModels('fixture-no-claude', { PATH: empty }, empty, line => logged.push(line),
      { memory: join(empty, 'memory.json') }), []);
    assert.deepEqual(logged, []);
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test('live picker rows replace the aliases once the query answers', async t => {
  const { root, env, memory } = fixture(t, `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:request.request_id,
 response:{models:[{value:'opus',displayName:'Opus fixture',supportedEffortLevels:['low','high']},{value:'claude-next',displayName:'Next fixture'}]}}}));
});`);
  const logged: string[] = [];
  const read = () => cachedClaudeModels('fixture-live-wins', env, root, line => logged.push(line), { memory });
  assert.deepEqual(read().map(row => row.modelId), ALIASES);
  await settle(read, () => read()[0]?.label === 'Opus fixture');
  const served = logged.length;
  const rows = read();
  assert.deepEqual(rows.map(row => row.modelId), ['opus', 'claude-next']);
  assert.deepEqual(rows[0]!.supportedEfforts, ['low', 'high']);
  assert.equal(logged.length, served, 'live rows are not a fallback');
  assert.ok(logged.every(line => !line.includes('query failed')));
});

test('a picker query that never answers reports its timeout', async t => {
  const { root } = fixture(t, 'setInterval(()=>{},1000)');
  const reasons: string[] = [];
  assert.deepEqual(await readClaudeModels(join(root, 'claude'), 'mac',
    { timeoutMs: 300, cwd: root, onFailure: reason => reasons.push(reason) }), []);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0]!, /timed out after 0.3 s/);
});

test('an answer already waiting when a held event loop reaches the deadline is read, not timed out', async t => {
  const { root } = fixture(t, `const fs=require('node:fs');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 fs.writeSync(1, JSON.stringify({type:'control_response',response:{subtype:'success',request_id:request.request_id,
 response:{models:[{value:'opus',displayName:'Opus held'}]}}})+'\\n');
 fs.writeFileSync('answered','');
});setInterval(()=>{},1000);`);
  const reasons: string[] = [];
  // A busy monitor: a check-phase callback holds the loop until the answer sits in the pipe and the
  // deadline has passed, so the next phase to run is the expired timer's.
  const held = await new Promise<{ rows: Promise<Array<{ label?: string }>> }>(resolve => setImmediate(() => {
    const started = Date.now();
    const pendingRows = readClaudeModels(join(root, 'claude'), 'mac',
      { timeoutMs: 200, cwd: root, onFailure: reason => reasons.push(reason) });
    while ((!existsSync(join(root, 'answered')) || Date.now() - started < 400) && Date.now() - started < 10_000) {
      /* hold the event loop */
    }
    resolve({ rows: pendingRows });
  }));
  assert.ok(existsSync(join(root, 'answered')), 'the fixture answered while the loop was held');
  const rows = await held.rows;
  assert.deepEqual(rows.map(row => row.label), ['Opus held']);
  assert.deepEqual(reasons, []);
});
