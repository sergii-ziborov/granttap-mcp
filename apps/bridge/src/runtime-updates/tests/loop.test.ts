import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,writeFileSync,utimesSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeUpdateLoop,startRuntimeUpdates } from '../index';
import { runtimeWorkTracker } from '../readiness';
import { trackHttpRuntimeWork } from '../http-readiness';
import express from 'express';
import { setImmediate } from 'node:timers/promises';

test('offline checks retry, idle checks respect cadence, and expired own locks are reclaimed',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'granttap-update-loop-'));let callbacks:Array<()=>void>=[],now=20_000_000,calls=0,reports=0,idle=false;
  const lock=join(directory,'install.lock');writeFileSync(lock,'');utimesSync(lock,0,0);
  const stop=runtimeUpdateLoop({root:directory,directory,idle:()=>idle,now:()=>now,
    schedule:((cb:()=>void)=>{callbacks.push(cb);return setTimeout(()=>{},100000);}) as typeof setTimeout,
    report:()=>{reports++;},check:async options=>{calls++;if(calls===1)throw Error('offline');options.activate?.('unused');return undefined;},activate:()=>{}});
  callbacks.shift()!();await setImmediate();assert.equal(calls,1);assert.equal(reports,1);assert.equal(existsSync(lock),false);
  callbacks.shift()!();await setImmediate();assert.equal(calls,2);
  idle=true;callbacks.shift()!();await setImmediate();assert.equal(calls,3);
  callbacks.shift()!();await setImmediate();assert.equal(calls,3);
  now+=4*60*60_000;callbacks.shift()!();await setImmediate();assert.equal(calls,4);
  stop();callbacks.shift()!();await setImmediate();assert.equal(calls,4);
});
test('work remains busy through errors and pending human decisions',async()=>{
  let pending=true;const work=runtimeWorkTracker(()=>pending);assert.equal(work.idle(),false);pending=false;
  let release!:()=>void;const job=work.run(()=>new Promise<void>(r=>{release=r;}));assert.equal(work.idle(),false);
  release();await job;assert.equal(work.idle(),true);
  await assert.rejects(work.run(async()=>{throw Error('delivery failed');}));assert.equal(work.idle(),true);
});
test('HTTP work drains after finish and close without decrementing twice',async t=>{
  const app=express(),idle=trackHttpRuntimeWork(app);let complete!:()=>void;
  app.get('/',(_req,res)=>{complete=()=>res.end('ok');});
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  t.after(()=>server.closeAllConnections());t.after(()=>server.close());
  const address=server.address() as {port:number};const response=fetch(`http://127.0.0.1:${address.port}/`);
  while(!complete)await setImmediate();assert.equal(idle(),false);complete();await (await response).text();
  await setImmediate();assert.equal(idle(),true);
});
test('test and development sessions never start automatic downloads',()=>{const stop=startRuntimeUpdates(()=>true);assert.equal(typeof stop,'function');stop();});

test('disabled, local, unowned, and source checkout launchers never download packages',t=>{
  const keys=['GRANTTAP_DISABLE_AUTO_UPDATE','GRANTTAP_LOCAL','NODE_TEST_CONTEXT'];
  const before=Object.fromEntries(keys.map(k=>[k,process.env[k]])),send=process.send;
  t.after(()=>{for(const k of keys)before[k]===undefined?delete process.env[k]:process.env[k]=before[k];process.send=send;});
  delete process.env.NODE_TEST_CONTEXT;process.env.GRANTTAP_DISABLE_AUTO_UPDATE='1';startRuntimeUpdates(()=>true)();
  delete process.env.GRANTTAP_DISABLE_AUTO_UPDATE;process.env.GRANTTAP_LOCAL='1';startRuntimeUpdates(()=>true)();
  delete process.env.GRANTTAP_LOCAL;process.send=undefined;startRuntimeUpdates(()=>true)();
  process.send=(()=>true) as typeof process.send;startRuntimeUpdates(()=>true)();
});
test('the default periodic check handles a normal no-update registry response',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'granttap-update-current-'));
  writeFileSync(join(directory,'package.json'),JSON.stringify({name:'granttap-mcp',version:'0.8.102'}));
  t.mock.method(globalThis,'fetch',async()=>new Response('{}'));
  let tick=()=>{};const stop=runtimeUpdateLoop({root:directory,directory,idle:()=>true,
    schedule:((cb:()=>void)=>{tick=cb;return setTimeout(()=>{},10000);}) as typeof setTimeout});
  tick();await new Promise(r=>setTimeout(r,20));stop();
  assert.equal(existsSync(join(directory,'active.json')),false);
});
