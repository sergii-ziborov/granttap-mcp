import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readClaudeModels, projectClaudeModels, cachedClaudeModels } from '../claude-models';

test('Claude picker metadata comes from a no-prompt initialization with exact labels and effort levels', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-claude-models-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, 'claude');
  writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const rl = require('node:readline').createInterface({input: process.stdin});
fs.writeFileSync('args.json', JSON.stringify(process.argv.slice(2)));
rl.on('line', line => {
 const request = JSON.parse(line);
 fs.writeFileSync('input.json', JSON.stringify(request));
 console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:request.request_id,
 response:{models:[{value:'default',displayName:'Default'},
 {value:'opus',displayName:'Opus fixture version',supportedEffortLevels:['low','high'],description:'Provider wording'},
 {value:'claude-custom',displayName:'Custom model',supportsEffort:false},
 {value:'bad id',displayName:'Invalid'}, {value:'opus',displayName:'Duplicate'}],account:{email:'private@example.test'}}}}));
});`);
  chmodSync(binary, 0o700);
  const rows = await readClaudeModels(binary, 'mac', { cwd: root });
  assert.deepEqual(rows.map(row => row.modelId), ['opus', 'claude-custom']);
  assert.equal(rows[0]!.label, 'Opus fixture version');
  assert.deepEqual(rows[0]!.supportedEfforts, ['low', 'high']);
  assert.deepEqual(rows[1]!.supportedEfforts, []);
  assert.equal(JSON.stringify(rows).includes('private@example.test'), false);
  const args = JSON.parse(readFileSync(join(root, 'args.json'), 'utf8'));
  assert.ok(args.includes('--no-session-persistence'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args.includes('--dangerously-skip-permissions'), false);
  const input = JSON.parse(readFileSync(join(root, 'input.json'), 'utf8'));
  assert.equal(input.type, 'control_request');
  assert.equal(input.request.subtype, 'initialize');
  assert.equal(input.prompt, undefined);
});

test('a missing CLI reports no invented Claude models', async () => {
  assert.deepEqual(await readClaudeModels('/nonexistent/claude', 'mac', { timeoutMs: 100 }), []);
});

test('Claude metadata bounds malformed rows and never manufactures effort support', () => {
  assert.deepEqual(projectClaudeModels(null, 'mac', 1), []);
  const rows = projectClaudeModels([null, 4, {}, {value: 1}, {value: '--option'},
    {value: 'claude-next', displayName: '  Next\nmodel ', supportsEffort: true},
    {value: 'opus', supportedEffortLevels: ['high', 'high', 'future', null]}], 'mac', 42);
  assert.equal(rows[0]!.label, 'Next model');
  assert.equal(rows[0]!.supportedEfforts, undefined);
  assert.deepEqual(rows[1]!.supportedEfforts, ['high']);
  assert.equal(rows[0]!.observedAt, 42);
});

test('metadata subprocess timeout, error and oversized output return an empty catalog', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-model-failures-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  for (const [name, body] of [
    ['timeout', "setInterval(()=>{},1000)"],
    ['oversize', "process.stdout.write('x'.repeat(600000));setInterval(()=>{},1000)"],
    ['invalid', "console.log('non-json');console.log(JSON.stringify({type:'control_response',response:{request_id:'wrong'}}));process.exit(1)"],
    ['error', "console.log(JSON.stringify({type:'control_response',response:{request_id:'granttap-model-catalog',subtype:'error'}}));setInterval(()=>{},1000)"],
  ]) {
    const binary = join(root, name!);
    writeFileSync(binary, '#!/usr/bin/env node\n'+body);chmodSync(binary,0o700);
    assert.deepEqual(await readClaudeModels(binary,'mac',{timeoutMs:300,cwd:root}),[]);
  }
});

test('native startup bookkeeping does not invalidate its own model reply, but an account change does', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-claude-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, 'claude'), config = join(root, '.claude.json'), probes = join(root, 'probes');
  writeFileSync(config, JSON.stringify({ oauthAccount: { accountUuid: 'account-a', organizationUuid: 'organization' }, numStartups: 1 }));
  writeFileSync(binary, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('--version')){console.log('2.1.296');process.exit(0);}
const root=process.env.CLAUDE_CONFIG_DIR;
const file=path.join(root,'.claude.json');
const config=JSON.parse(fs.readFileSync(file,'utf8'));
fs.writeFileSync(file,JSON.stringify({...config,numStartups:(config.numStartups||0)+1}));
fs.appendFileSync(path.join(root,'probes'),'x');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:request.request_id,
 response:{models:[{value:'claude-'+config.oauthAccount.accountUuid,displayName:'Native model'}]}}}));
});`); chmodSync(binary, 0o700);
  const env = { ...process.env, GRANTTAP_CLAUDE_BIN: binary, GRANTTAP_CLAUDE_DIR: root };
  const waitFor = async (model: string) => {
    const end = Date.now() + 4_000;
    while (Date.now() < end) {
      const rows = cachedClaudeModels('fixture-account-scope', env);
      if (rows.some(row => row.modelId === model)) return rows;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.fail('A metadata process that updates startup bookkeeping must still publish its model reply');
  };
  const first = await waitFor('claude-account-a');
  assert.equal(first[0]!.endpointId, 'fixture-account-scope');
  assert.equal(readFileSync(probes, 'utf8').length, 1, 'One initialization must not become a respawn loop');
  const saved = JSON.parse(readFileSync(config, 'utf8'));
  writeFileSync(config, JSON.stringify({ ...saved, numStartups: saved.numStartups + 1, theme: 'changed' }));
  assert.equal(cachedClaudeModels('fixture-account-scope', env)[0]?.modelId, 'claude-account-a');
  assert.equal(readFileSync(probes, 'utf8').length, 1);
  writeFileSync(config, JSON.stringify({ ...saved, oauthAccount: { ...saved.oauthAccount, accountUuid: 'account-b' } }));
  assert.deepEqual(cachedClaudeModels('fixture-account-scope', env), [], 'A different account must not inherit old model metadata');
  await waitFor('claude-account-b');
  assert.equal(readFileSync(probes, 'utf8').length, 2);
});
