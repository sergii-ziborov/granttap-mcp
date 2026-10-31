import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {deliverToSession,isDeliveryInFlight,hasPendingDeliveries} from '../..';
import {observeSessionExecution} from '../../../session-catalog/observed-state';
import {restoreNativeTranscriptSource} from '../../../sessions/native-source';
import {rememberPublishedCatalog} from '../../../session-catalog';
import {startTaskDispatchMonitor} from '../../../task-dispatch/worker/monitor';
import {generateKeyPair} from '../../../../../../packages/core/crypto';
import type {SessionInfo,TaskDispatch} from '../../../../../../packages/protocol/schema';

test('a native model end-turn cannot admit another CLI while the first invocation owns background work',async t=>{
  const root=mkdtempSync(join(tmpdir(),'claude-background-owner-')),logs=join(root,'logs'),bin=join(root,'claude');mkdirSync(logs);
  const changes={GRANTTAP_CONFIG_DIR:root,GRANTTAP_CLAUDE_PROJECTS_DIR:logs,GRANTTAP_CLAUDE_BIN:bin};
  const prior=Object.fromEntries(Object.keys(changes).map(key=>[key,process.env[key]]));Object.assign(process.env,changes);
  const wait=async(predicate:()=>boolean)=>{const until=Date.now()+5000;while(!predicate()&&Date.now()<until)await new Promise(r=>setTimeout(r,10));assert.ok(predicate())};
  let stop=()=>{};
  t.after(async()=>{stop();writeFileSync(join(root,'release'),'1');await wait(()=>!hasPendingDeliveries());
    for(const [key,value]of Object.entries(prior))if(value===undefined)delete process.env[key];else process.env[key]=value;
    rmSync(root,{recursive:true,force:true});});
  writeFileSync(bin,`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),root=process.env.GRANTTAP_CONFIG_DIR;
if(process.argv.includes('--version')){console.log('Claude fixture');process.exit(0)}
const file=path.join(root,'logs','native-test.jsonl'),timestamp=new Date().toISOString();
fs.writeFileSync(file,JSON.stringify({type:'user',sessionId:'native-test',timestamp,message:{role:'user',content:process.argv.at(-1)}})+'\\n'+JSON.stringify({type:'assistant',sessionId:'native-test',timestamp,message:{role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:'Background checks are still running'}]}})+'\\n');
const timer=setInterval(()=>{if(!fs.existsSync(path.join(root,'release')))return;clearInterval(timer);console.log(JSON.stringify({type:'result',is_error:false,result:'Background work really finished'}));},10);
`,{mode:0o755});
  const now=Date.now(),session:SessionInfo={sessionId:'native-test',agent:'claude',cwd:root,state:'working',startedAt:now,lastActivityAt:now,tokensSession:0,tokensLastTurn:0};
  const first=deliverToSession(session,'First exact synthetic prompt',10_000);
  const file=join(logs,'native-test.jsonl');await wait(()=>existsSync(file));assert.ok(restoreNativeTranscriptSource(session,file));
  assert.equal(observeSessionExecution(session)?.session.state,'idle');assert.equal(isDeliveryInFlight(session.sessionId),true);
  const own=generateKeyPair(),peer=generateKeyPair(),config={relayUrl:'ws://127.0.0.1:1',room:'background-owner-fixture',role:'machine' as const,deviceName:'Fixture',senderId:'fixture',myPublicKey:own.publicKey,mySecretKey:own.secretKey,peerPublicKey:peer.publicKey};
  let incoming!: (job:TaskDispatch,key:string)=>void,claims=0,completed=false;
  const client={room:config.room,isConnected:true,setSessionKey:()=>{},onTaskDispatch:(callback:typeof incoming)=>{incoming=callback;return()=>{}},send:async()=>{},sendSession:async()=>{}};
  rememberPublishedCatalog(client as never,{type:'sessions.status',machine:'Fixture',sessions:[session],generatedAt:Date.now()});
  stop=startTaskDispatchMonitor({config,client:client as never,isLeader:()=>true,peerAllowed:()=>true,publish:async()=>{},
    remote:{get:async()=> 'queued',claim:async()=>{claims++;return true},finish:async()=>{completed=true}},
    deliver:async(_job,beforeStart)=>{await beforeStart();return 'accepted'}});
  incoming({type:'task.dispatch',jobId:'background-job-01',token:'a'.repeat(64),sessionId:session.sessionId,deliveryMode:'immediate',notBefore:now,createdAt:now,expiresAt:now+86400000,
    operation:{type:'user.message',messageId:'background-message-01',sessionId:session.sessionId,text:'Next distinct prompt',createdAt:now}},peer.publicKey);
  await new Promise(r=>setTimeout(r,2300));
  assert.equal(claims,0,'an end_turn line must not acknowledge or run a second request over background work');
  writeFileSync(join(root,'release'),'1');assert.equal((await first).ok,true);
  await wait(()=>completed);assert.equal(claims,1,'one receiver claim after the actual invocation returns');
});
