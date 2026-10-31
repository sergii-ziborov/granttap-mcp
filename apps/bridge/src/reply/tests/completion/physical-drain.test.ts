import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {deliverToSession,isDeliveryInFlight,hasPendingDeliveries,completeObservedNativeTurn} from '../..';
import {observeSessionExecution} from '../../../session-catalog/observed-state';
import {restoreNativeTranscriptSource} from '../../../sessions/native-source';
import type {SessionInfo} from '../../../../../../packages/protocol/schema';

test('native completion admits a follow-up while the old CLI drains, without losing physical ownership',async t=>{
  const root=mkdtempSync(join(tmpdir(),'claude-logical-turn-')),logs=join(root,'logs'),bin=join(root,'claude');mkdirSync(logs);
  const changes={GRANTTAP_CONFIG_DIR:root,GRANTTAP_CLAUDE_PROJECTS_DIR:logs,GRANTTAP_CLAUDE_BIN:bin};
  const before=Object.fromEntries(Object.keys(changes).map(key=>[key,process.env[key]]));Object.assign(process.env,changes);
  const wait=async(predicate:()=>boolean)=>{const until=Date.now()+5000;while(!predicate()&&Date.now()<until)await new Promise(r=>setTimeout(r,10));assert.ok(predicate())};
  t.after(async()=>{
    for(const n of [1,2])writeFileSync(join(root,'release-'+n),'1');
    await wait(()=>!hasPendingDeliveries());
    for(const [key,value]of Object.entries(before))if(value===undefined)delete process.env[key];else process.env[key]=value;
    rmSync(root,{recursive:true,force:true});
  });
  writeFileSync(bin,`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),root=process.env.GRANTTAP_CONFIG_DIR;
if(process.argv.includes('--version')){console.log('Claude fixture');process.exit(0)}
const countFile=path.join(root,'count'),n=fs.existsSync(countFile)?Number(fs.readFileSync(countFile))+1:1;fs.writeFileSync(countFile,String(n));
const file=path.join(root,'logs','native-test.jsonl'),prompt=process.argv.at(-1),timestamp=new Date().toISOString();
fs.appendFileSync(file,JSON.stringify({type:'user',sessionId:'native-test',timestamp,message:{role:'user',content:prompt}})+'\\n');
fs.appendFileSync(file,JSON.stringify({type:'assistant',sessionId:'native-test',timestamp:new Date().toISOString(),message:{role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:'Native final '+n}]}})+'\\n');
fs.writeFileSync(path.join(root,'ready-'+n),String(process.pid));
const timer=setInterval(()=>{if(!fs.existsSync(path.join(root,'release-'+n)))return;clearInterval(timer);console.log(JSON.stringify({type:'result',is_error:false,result:'Physical CLI drained '+n}));},10);
`,{mode:0o755});
  const session:SessionInfo={sessionId:'native-test',agent:'claude',cwd:root,state:'working',startedAt:Date.now(),lastActivityAt:Date.now(),tokensSession:0,tokensLastTurn:0};
  const first=deliverToSession(session,'First exact synthetic prompt',10_000);
  await wait(()=>existsSync(join(root,'ready-1')));
  assert.ok(restoreNativeTranscriptSource(session,join(logs,'native-test.jsonl')));
  const firstProof=observeSessionExecution(session)?.completion;assert.ok(firstProof);
  assert.equal(completeObservedNativeTurn(session.sessionId,firstProof),true);
  assert.deepEqual(await first,{ok:true,text:'Native final 1',delivery:'native'});
  assert.equal(isDeliveryInFlight(session.sessionId),false);assert.equal(hasPendingDeliveries(),true);
  const second=deliverToSession(session,'Second exact synthetic prompt',10_000);
  await wait(()=>existsSync(join(root,'ready-2')));
  assert.equal(completeObservedNativeTurn(session.sessionId,firstProof),false,'old completion cannot acknowledge the next prompt');
  writeFileSync(join(root,'release-1'),'1');
  await new Promise(r=>setTimeout(r,100));
  assert.equal(isDeliveryInFlight(session.sessionId),true,'old physical cleanup cannot clear the new turn');
  const secondProof=observeSessionExecution(session)?.completion;assert.ok(secondProof);
  assert.equal(completeObservedNativeTurn(session.sessionId,secondProof),true);
  assert.deepEqual(await second,{ok:true,text:'Native final 2',delivery:'native'});
  assert.equal(hasPendingDeliveries(),true,'runtime handoff still waits for physical background work');
  writeFileSync(join(root,'release-2'),'1');await wait(()=>!hasPendingDeliveries());
  assert.equal(isDeliveryInFlight(session.sessionId),false);
  assert.equal(Number(readFileSync(join(root,'count'))),2,'one physical invocation per distinct message');
});
