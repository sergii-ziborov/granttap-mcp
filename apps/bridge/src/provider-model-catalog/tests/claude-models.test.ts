import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readClaudeModels, projectClaudeModels } from '../claude-models';

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
