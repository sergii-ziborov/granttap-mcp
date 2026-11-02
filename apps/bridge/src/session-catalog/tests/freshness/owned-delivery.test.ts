import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {deliverToSession} from '../../../reply';
import {restoreNativeTranscriptSource} from '../../../sessions';
import {observeSessionExecution,refreshObservedCatalog} from '../../observed-state';
import type {SessionInfo,SessionsStatus} from '../../../../../../packages/protocol/schema';

test('a chat whose headless run is still executing a quiet tool call is published as Working until the run ends',async t=>{
  const root=mkdtempSync(join(tmpdir(),'owned-delivery-')),logs=join(root,'logs'),bin=join(root,'claude');
  mkdirSync(join(logs,'fixture-project'),{recursive:true});
  const changes={GRANTTAP_CONFIG_DIR:root,GRANTTAP_CLAUDE_PROJECTS_DIR:logs,GRANTTAP_CLAUDE_BIN:bin};
  const prior=Object.fromEntries(Object.keys(changes).map(key=>[key,process.env[key]]));Object.assign(process.env,changes);
  t.after(()=>{for(const [key,value] of Object.entries(prior))if(value===undefined)delete process.env[key];else process.env[key]=value;
    rmSync(root,{recursive:true,force:true});});
  // The provider is busy in one long tool call: nothing reaches its transcript until the call returns.
  writeFileSync(bin,`#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('Claude fixture');process.exit(0)}
setTimeout(()=>console.log(JSON.stringify({type:'result',is_error:false,result:'Synthetic build finished'})),300);
`,{mode:0o755});
  const now=Date.now(),quiet=now-43*60_000;
  const chat=(sessionId:string,state:SessionInfo['state']):SessionInfo=>({sessionId,agent:'claude',cwd:root,state,
    startedAt:quiet-60_000,lastActivityAt:quiet,tokensSession:0,tokensLastTurn:0});
  const building=chat('building-chat','idle'),asking=chat('asking-chat','waiting'),resting=chat('resting-chat','idle');
  const file=join(logs,'fixture-project','building-chat.jsonl');
  const row=(type:string,at:number,stop?:string)=>JSON.stringify({type,sessionId:'building-chat',timestamp:new Date(at).toISOString(),
    message:{role:type,stop_reason:stop,content:[{type:'text',text:'Synthetic build step'}]}})+'\n';
  writeFileSync(file,row('user',quiet-60_000)+row('assistant',quiet,'tool_use'));
  assert.equal(restoreNativeTranscriptSource(building,file),true);
  const status:SessionsStatus={type:'sessions.status',machine:'Fixture',generatedAt:now,
    sessions:[building,asking,resting],tokensRecent:0,tokenWindowHours:24};
  const state=(catalog:SessionsStatus,id:string)=>catalog.sessions.find(session=>session.sessionId===id)?.state;
  assert.equal(state(refreshObservedCatalog(status),'building-chat'),'idle','a quiet transcript alone reads as Idle');
  const before=observeSessionExecution(building)?.revision;

  const runs=[deliverToSession(building,'Synthetic follow-up',5_000),deliverToSession(asking,'Synthetic answer',5_000)];
  const during=refreshObservedCatalog(status);
  assert.equal(state(during,'building-chat'),'working','the run this computer owns is still executing');
  assert.equal(state(during,'asking-chat'),'waiting','a chat waiting for the person keeps Waiting');
  assert.equal(state(during,'resting-chat'),'idle','a chat without a live run keeps its own state');
  const running=observeSessionExecution(building);
  assert.equal(running?.session.state,'working','an open chat follows the same rule');
  assert.notEqual(running?.revision,before,'an open chat republishes when its run starts');

  for(const result of await Promise.all(runs))assert.equal(result.ok,true);
  const after=refreshObservedCatalog(status);
  assert.equal(state(after,'building-chat'),'idle','the transcript decides again once the run has ended');
  assert.equal(state(after,'asking-chat'),'waiting');
  const finished=observeSessionExecution(building);
  assert.equal(finished?.session.state,'idle');
  assert.notEqual(finished?.revision,running?.revision,'an open chat republishes when its run ends');
});
