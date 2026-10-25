import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,mkdirSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newerVersion,readState,runtimeVersion,saveState,selectedRuntime,rollbackRuntime,versionRoot,validRuntime } from '../selection.mjs';

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'granttap-selection-')),bundled=join(dir,'bundled');mkdirSync(bundled);
 writeFileSync(join(bundled,'package.json'),JSON.stringify({name:'granttap-mcp',version:'0.8.101'}));
 const add=(version:string)=>{const root=versionRoot(dir,version);mkdirSync(join(root,'bin'),{recursive:true});
 writeFileSync(join(root,'bin/granttap-mcp.mjs'),'');writeFileSync(join(root,'package.json'),JSON.stringify({name:'granttap-mcp',version}));return root;};
 return {dir,bundled,add};
}
test('only an exact managed package may supersede a bundled runtime',()=>{
 const f=fixture();assert.equal(newerVersion('0.8.101','0.8.101'),false);assert.equal(newerVersion('bad','0.8.1'),false);
 const root=f.add('0.8.102');saveState(f.dir,{root:f.bundled,version:'0.8.102'});assert.equal(selectedRuntime(f.bundled,f.dir),f.bundled);
 saveState(f.dir,{root,version:'0.8.102'});assert.equal(selectedRuntime(f.bundled,f.dir),root);
 writeFileSync(join(root,'package.json'),JSON.stringify({name:'untrusted',version:'0.8.102'}));
 assert.equal(validRuntime(root,f.dir,'0.8.102'),false);assert.throws(()=>runtimeVersion(root));assert.equal(selectedRuntime(f.bundled,f.dir),f.bundled);
});
test('rollback changes only the failed active version and restores an earlier verified cache',()=>{
 const f=fixture();assert.equal(rollbackRuntime(f.bundled,f.dir),false);
 const old=f.add('0.8.102'),bad=f.add('0.8.103');saveState(f.dir,{root:bad,version:'0.8.103',previous:{root:old,version:'0.8.102'}});
 assert.equal(rollbackRuntime(f.bundled,f.dir,'unrelated'),false);assert.equal(selectedRuntime(f.bundled,f.dir),bad);
 assert.equal(rollbackRuntime(f.bundled,f.dir,bad),true);assert.equal(selectedRuntime(f.bundled,f.dir),old);
 assert.equal(readState(f.dir).rejectedVersion,'0.8.103');
});
