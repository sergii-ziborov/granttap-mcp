import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { EndpointModelCatalog } from '../../../../../packages/protocol/schema';
import { cachedClaudeModels, readClaudeModels } from '../claude-models';

const ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];

function fixture(t: TestContext, body: string) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-claude-aliases-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, 'claude');
  writeFileSync(binary, `#!/usr/bin/env node\nif(process.argv.includes('--version')){console.log('2.1.296');process.exit(0)}\n${body}`);
  chmodSync(binary, 0o700);
  // Node runs the fixture; the explicit override is the only Claude Code this test installs.
  return { root, env: { PATH: dirname(process.execPath), GRANTTAP_CLAUDE_BIN: binary, GRANTTAP_CLAUDE_DIR: root } };
}

async function settle(read: () => unknown, done: () => boolean) {
  const end = Date.now() + 5_000;
  while (!done() && Date.now() < end) { read(); await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.ok(done(), 'the picker query must settle');
}

test('an installed Claude Code whose picker query fails still advertises its aliases and records why', async t => {
  const { root, env } = fixture(t, "process.stderr.write('Synthetic startup failure\\n');process.exit(3);");
  const logged: string[] = [];
  const read = () => cachedClaudeModels('fixture-alias-fallback', env, root, line => logged.push(line));
  assert.deepEqual(read().map(row => row.modelId), ALIASES, 'the phone has a list while the query runs');
  await settle(read, () => logged.length > 0);
  const rows = read();
  assert.deepEqual(rows.map(row => row.modelId), ALIASES);
  assert.deepEqual(rows.map(row => row.priority), [0, 1, 2, 3]);
  assert.ok(rows.every(row => row.provider === 'claude' && row.source === 'advertised'
    && row.endpointId === 'fixture-alias-fallback' && row.observedAt > 0 && row.label));
  assert.ok(EndpointModelCatalog.safeParse({ endpointId: 'fixture-alias-fallback', observedAt: 1, models: rows }).success);
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /code 3/);
  assert.match(logged[0]!, /Synthetic startup failure/);
  read(); read();
  assert.equal(logged.length, 1, 'an unchanged failure is recorded once, not on every catalog read');
});

test('a Mac without Claude Code advertises no Claude models and starts nothing', () => {
  const empty = mkdtempSync(join(tmpdir(), 'granttap-no-claude-'));
  try {
    const logged: string[] = [];
    assert.deepEqual(cachedClaudeModels('fixture-no-claude', { PATH: empty }, empty, line => logged.push(line)), []);
    assert.deepEqual(logged, []);
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test('live picker rows replace the aliases once the query answers', async t => {
  const { root, env } = fixture(t, `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:request.request_id,
 response:{models:[{value:'opus',displayName:'Opus fixture',supportedEffortLevels:['low','high']},{value:'claude-next',displayName:'Next fixture'}]}}}));
});`);
  const logged: string[] = [];
  const read = () => cachedClaudeModels('fixture-live-wins', env, root, line => logged.push(line));
  assert.deepEqual(read().map(row => row.modelId), ALIASES);
  await settle(read, () => read()[0]?.label === 'Opus fixture');
  const rows = read();
  assert.deepEqual(rows.map(row => row.modelId), ['opus', 'claude-next']);
  assert.deepEqual(rows[0]!.supportedEfforts, ['low', 'high']);
  assert.deepEqual(logged, []);
});

test('a picker query that never answers reports its timeout', async t => {
  const { root } = fixture(t, 'setInterval(()=>{},1000)');
  const reasons: string[] = [];
  assert.deepEqual(await readClaudeModels(join(root, 'claude'), 'mac',
    { timeoutMs: 300, cwd: root, onFailure: reason => reasons.push(reason) }), []);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0]!, /timed out/);
});
