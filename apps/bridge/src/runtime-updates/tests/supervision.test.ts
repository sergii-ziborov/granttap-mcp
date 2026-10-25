import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync,mkdirSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { selectedRuntime,saveState,versionRoot } from '../selection.mjs';
// @ts-expect-error The supervisor is a launcher-only JavaScript boundary.
import { superviseRuntime } from '../supervision.mjs';
import { runtimeUpdateReadiness } from '../readiness';

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'granttap-update-supervisor-')),bundled=join(directory,'bundled');
  mkdirSync(bundled);writeFileSync(join(bundled,'package.json'),JSON.stringify({name:'granttap-mcp',version:'0.8.101'}));
  const candidate=versionRoot(directory,'0.8.102');mkdirSync(join(candidate,'bin'),{recursive:true});
  writeFileSync(join(candidate,'bin','granttap-mcp.mjs'),'');writeFileSync(join(candidate,'package.json'),JSON.stringify({name:'granttap-mcp',version:'0.8.102'}));
  return {directory,bundled,candidate};
}
test('a new owned service that crashes before health acknowledgement rolls back',async()=>{
  const f=fixture();saveState(f.directory,{root:f.candidate,version:'0.8.102'});
  const child=spawn(process.execPath,['-e','process.exit(1)']);
  const guard=superviseRuntime(child,{...f,root:f.candidate});
  child.once('exit',(code,signal)=>guard.onExit(code,signal));await once(child,'close');
  assert.equal(selectedRuntime(f.bundled,f.directory),f.bundled);
});
test('updates drain only the owned child after its readiness response',()=>{
  const f=fixture();const child=Object.assign(new EventEmitter(),{connected:true,send:(_m:unknown)=>{},kill:(_s:string)=>{kills++;}});
  let tick=()=>{},kills=0,requests=0;child.send=()=>{requests++;};
  const guard=superviseRuntime(child,{...f,root:f.bundled,schedule:(callback:()=>void)=>{tick=callback;return setInterval(()=>{},10000);}});
  saveState(f.directory,{root:f.candidate,version:'0.8.102'});tick();assert.equal(kills,0);assert.equal(requests,1);
  child.emit('message',{type:'unrelated'});assert.equal(kills,0);
  child.emit('message',{type:'granttap.runtime-update-ready'});assert.equal(kills,1);guard.stop();
});
test('pending requests suppress a readiness response without changing any approval',t=>{
  const sent:unknown[]=[];const before=process.send;process.send=((m:unknown)=>{sent.push(m);return true;}) as typeof process.send;t.after(()=>{process.send=before;});let idle=false;
  const stop=runtimeUpdateReadiness(()=>idle);assert.equal(sent.length,1); // startup health
  (process as EventEmitter).emit('message',{type:'unrelated'});(process as EventEmitter).emit('message',{type:'granttap.runtime-update-check'});assert.equal(sent.length,1);
  idle=true;(process as EventEmitter).emit('message',{type:'granttap.runtime-update-check'});assert.equal(sent.length,2);stop();
});

test('an unresponsive new service rolls back after a bounded startup window',()=>{
  const f=fixture();saveState(f.directory,{root:f.candidate,version:'0.8.102'});
  let now=1,tick=()=>{},kills=0;
  const child=Object.assign(new EventEmitter(),{connected:false,send:()=>{},kill:()=>{kills++;}});
  const guard=superviseRuntime(child,{...f,root:f.candidate,now:()=>now,schedule:(cb:()=>void)=>{tick=cb;return setInterval(()=>{},10000);}});
  now+=121000;tick();tick();assert.equal(kills,1);assert.equal(selectedRuntime(f.bundled,f.directory),f.bundled);guard.stop();
});
test('a responsive selected service is retained, and later external shutdown does not quarantine it',()=>{
  const f=fixture();saveState(f.directory,{root:f.candidate,version:'0.8.102'});
  const child=Object.assign(new EventEmitter(),{connected:false,send:()=>{},kill:()=>{}});
  const guard=superviseRuntime(child,{...f,root:f.candidate});child.emit('message',{type:'granttap.runtime-healthy'});
  guard.onExit(0,'SIGTERM');assert.equal(selectedRuntime(f.bundled,f.directory),f.candidate);
});
