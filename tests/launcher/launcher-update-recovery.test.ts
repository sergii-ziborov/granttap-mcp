import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';

test('an installed cache without its loader rolls back before service startup',()=>{
  const source=join(import.meta.dirname,'../..');
  const directory=mkdtempSync(join(tmpdir(),'granttap-loader-recovery-'));
  const bundled=join(directory,'installed','node_modules','granttap-mcp'),config=join(directory,'config'),updates=join(config,'runtime-updates');
  for(const file of ['bin/granttap-mcp.mjs','apps/bridge/src/runtime-updates/selection.mjs','apps/bridge/src/runtime-updates/supervision.mjs','apps/bridge/src/runtime-updates/preferences/storage.mjs','apps/bridge/src/config/runtime/node-requirement.mjs']){
   const target=join(bundled,file);mkdirSync(dirname(target),{recursive:true});copyFileSync(join(source,file),target);
  }
  writeFileSync(join(bundled,'package.json'),readFileSync(join(source,'package.json')));
  const nextVersion=JSON.parse(readFileSync(join(bundled,'package.json'),'utf8')).version.split('.').map(Number);
  nextVersion[2]++;const badVersion=nextVersion.join('.');
  const bad=join(updates,'versions',badVersion,'node_modules','granttap-mcp');mkdirSync(join(bad,'bin'),{recursive:true});
  writeFileSync(join(bad,'package.json'),JSON.stringify({name:'granttap-mcp',version:badVersion}));writeFileSync(join(bad,'bin/granttap-mcp.mjs'),'');
  writeFileSync(join(updates,'active.json'),JSON.stringify({root:bad,version:badVersion}));
  const env:NodeJS.ProcessEnv={...process.env,GRANTTAP_CONFIG_DIR:config};for(const key of ['NODE_PATH','NODE_TEST_CONTEXT','GRANTTAP_LOCAL','GRANTTAP_DISABLE_AUTO_UPDATE'])delete env[key];
  const result=spawnSync(process.execPath,[join(bundled,'bin/granttap-mcp.mjs'),'internal','serve'],{env,encoding:'utf8',timeout:10000});
  assert.match(result.stderr,/unable to resolve the installed tsx runtime/);
  assert.equal(result.status,1);
  const state=JSON.parse(readFileSync(join(updates,'active.json'),'utf8'));
  assert.equal(state.version,undefined,'The selected broken cache must not remain active after loader failure.');
  assert.equal(state.rejectedVersion,badVersion);
  
});
