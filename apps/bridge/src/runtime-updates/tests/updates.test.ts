import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkForRuntimeUpdate } from '../index';
import { selectedRuntime, rollbackRuntime } from '../selection.mjs';
import { saveAutomaticUpdateSetting, automaticUpdatesAllowed } from '../preferences/storage.mjs';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'granttap-runtime-update-'));
  const bundled = join(directory, 'bundled');
  mkdirSync(bundled); writeFileSync(join(bundled, 'package.json'), JSON.stringify({name:'granttap-mcp',version:'0.8.101'}));
  const state = join(directory, 'updates');
  const candidate = join(state, 'versions', '0.8.102', 'node_modules', 'granttap-mcp');
  const metadata = {name:'granttap-mcp',version:'0.8.102',dist:{integrity:'sha512-'+Buffer.alloc(64,3).toString('base64'),tarball:'https://registry.npmjs.org/granttap-mcp/-/granttap-mcp-0.8.102.tgz'}};
  const options = {root:bundled,stateDirectory:state,now:()=>123456789,
    latest:async()=>metadata,idle:()=>true,
    install:async()=>{mkdirSync(join(candidate,'bin'),{recursive:true});writeFileSync(join(candidate,'package.json'),JSON.stringify({name:'granttap-mcp',version:'0.8.102'}));writeFileSync(join(candidate,'bin/granttap-mcp.mjs'),'');},
    verify:async()=>{},activate:()=>{}};
  return {directory,bundled,state,candidate,metadata,options};
}

test('a qualified stable release becomes the selected runtime without changing pairing or policy',async()=>{
  const f=fixture(); const pairing=join(f.directory,'machine.json');writeFileSync(pairing,'unchanged');
  assert.equal(await checkForRuntimeUpdate(f.options),f.candidate);
  assert.equal(selectedRuntime(f.bundled,f.state),f.candidate);
  assert.equal(readFileSync(pairing,'utf8'),'unchanged');
});
test('an explicit phone update can install while automatic updates remain disabled', async()=>{
  const f=fixture();saveAutomaticUpdateSetting(f.state,false);
  assert.equal(await checkForRuntimeUpdate(f.options),undefined);
  assert.equal(await checkForRuntimeUpdate({...f.options,manual:true}),f.candidate);
  assert.equal(automaticUpdatesAllowed(f.state),false,'A manual request does not change the saved preference');
});
test('pending human decisions defer activation and the next idle check can apply the same release',async()=>{
  const f=fixture();let idle=false;let installs=0;const install=f.options.install;
  f.options.idle=()=>idle;f.options.install=async()=>{installs++;await install();};
  assert.equal(await checkForRuntimeUpdate(f.options),undefined);
  assert.equal(selectedRuntime(f.bundled,f.state),f.bundled);
  idle=true;assert.equal(await checkForRuntimeUpdate(f.options),f.candidate);assert.equal(installs,1);
});
test('a failed verification leaves the working runtime active',async()=>{
  const f=fixture();f.options.verify=async()=>{throw Error('smoke failed');};
  await assert.rejects(checkForRuntimeUpdate(f.options),/smoke failed/);
  assert.equal(selectedRuntime(f.bundled,f.state),f.bundled);
  assert.equal(existsSync(join(f.state,'active.json')),false);
});
test('startup failure restores the previous selection and quarantines that version',async()=>{
  const f=fixture();await checkForRuntimeUpdate(f.options);
  assert.equal(rollbackRuntime(f.bundled,f.state),true);
  assert.equal(selectedRuntime(f.bundled,f.state),f.bundled);
  assert.equal(await checkForRuntimeUpdate(f.options),undefined);
});
test('non-registry, prerelease, and downgrade candidates cannot replace the installed runtime',async()=>{
  for(const mutation of [{version:'0.8.100'},{version:'0.8.103-beta.1'},{dist:{tarball:'https://example.com/runtime.tgz',integrity:'sha512-invalid'}}]){
    const f=fixture();f.options.latest=async()=>({...f.metadata,...mutation} as any);
    assert.equal(await checkForRuntimeUpdate(f.options),undefined);
    assert.equal(selectedRuntime(f.bundled,f.state),f.bundled);
  }
});
test('concurrent update checks share the installation lock',async()=>{
  const f=fixture();let installs=0;const install=f.options.install;
  f.options.install=async()=>{installs++;await new Promise(r=>setTimeout(r,20));await install();};
  await Promise.all([checkForRuntimeUpdate(f.options),checkForRuntimeUpdate(f.options)]);
  assert.equal(installs,1);
});

test('failed candidates are verified again and cannot activate just because staging files remain',async()=>{
  const f=fixture();let attempts=0;f.options.verify=async()=>{attempts++;throw Error('broken runtime');};
  await assert.rejects(checkForRuntimeUpdate(f.options),/broken runtime/);
  await assert.rejects(checkForRuntimeUpdate(f.options),/broken runtime/);
  assert.equal(attempts,2);assert.equal(selectedRuntime(f.bundled,f.state),f.bundled);
});
