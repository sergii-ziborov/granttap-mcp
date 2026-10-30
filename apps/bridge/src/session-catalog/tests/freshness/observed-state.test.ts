import assert from 'node:assert/strict';
import {appendFileSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {rememberPublishedCatalog} from '../..';
import {publishSessionEvents} from '../../../monitor/handlers/catalog';
import {restoreNativeTranscriptSource} from '../../../sessions';
import {dispatchSessionObservation, taskDispatchReady} from '../../../task-dispatch/worker/readiness';
import {refreshObservedCatalog} from '../../observed-state';
import type {SessionInfo,SessionActivity} from '../../../../../../packages/protocol/schema';

test('an open Claude chat reads completion and a following turn without a full catalog refresh',async t=>{
  const root=mkdtempSync(join(tmpdir(),'observed-turn-')),logs=join(root,'logs');mkdirSync(logs);
  const prior={config:process.env.GRANTTAP_CONFIG_DIR,claude:process.env.GRANTTAP_CLAUDE_PROJECTS_DIR};
  process.env.GRANTTAP_CONFIG_DIR=root;process.env.GRANTTAP_CLAUDE_PROJECTS_DIR=logs;
  t.after(()=>{for(const [key,value] of [['GRANTTAP_CONFIG_DIR',prior.config],['GRANTTAP_CLAUDE_PROJECTS_DIR',prior.claude]]){if(value===undefined)delete process.env[key!];else process.env[key!]=value}rmSync(root,{recursive:true,force:true})});
  const now=Date.now(),file=join(logs,'fresh-chat.jsonl');
  const line=(type:string,offset:number,stop?:string)=>JSON.stringify({type,sessionId:'fresh-chat',timestamp:new Date(now+offset).toISOString(),message:{role:type,stop_reason:stop,content:[{type:'text',text:stop??'Synthetic prompt'}]}})+'\n';
  writeFileSync(file,line('user',-2000)+line('assistant',-1000,'end_turn'));
  const session:SessionInfo={sessionId:'fresh-chat',agent:'claude',state:'working',startedAt:now-2000,lastActivityAt:now-2000,tokensSession:0,tokensLastTurn:0};
  assert.equal(restoreNativeTranscriptSource(session,file),true);
  const pages:SessionActivity[]=[];
  const client={room:'fixture',isConnected:true,setSessionKey:()=>{},send:async()=>{},sendSession:async(payload:SessionActivity)=>{if(payload.type==='session.activity')pages.push(payload)}};
  rememberPublishedCatalog(client as never,{type:'sessions.status',machine:'Fixture',generatedAt:now-2000,sessions:[session],tokensRecent:0,tokenWindowHours:24});
  await publishSessionEvents(client as never,session.sessionId);
  assert.equal(pages.at(-1)?.state,'idle','native end_turn must win over a cached Working catalog');
  appendFileSync(file,line('user',0));
  await publishSessionEvents(client as never,session.sessionId);
  assert.equal(pages.at(-1)?.state,'working');
  assert.ok(pages.at(-1)?.entries.some(row=>row.kind==='user'&&row.createdAt===now),'the next prompt must bypass the stale transcript cache');
  appendFileSync(file, line('assistant',0));
  await publishSessionEvents(client as never,session.sessionId);
  assert.equal(pages.at(-1)?.state,'working');
  assert.ok(pages.at(-1)?.entries.some(row=>row.kind!=='user'&&row.createdAt===now),
    'streaming rows with the same clock and state still invalidate the head cache');
  appendFileSync(file,line('assistant',1,'end_turn'));
  await publishSessionEvents(client as never,session.sessionId);
  assert.equal(pages.at(-1)?.state,'idle');
  const lateCatalog = refreshObservedCatalog({type:'sessions.status',machine:'Fixture',
    sessions:[session],history:[session],generatedAt:now+10_000,tokensRecent:0,tokenWindowHours:24});
  assert.equal(lateCatalog.sessions[0]?.state,'idle',
    'a scan that captured Working before completion cannot restore it when it publishes late');
  assert.equal(lateCatalog.history?.[0]?.state,'idle');
  const job = {sessionId:session.sessionId, deliveryMode:'queued'};
  const old = {session, generatedAt:now-120_000, inFlight:false, paused:false};
  assert.equal(taskDispatchReady(job as never,old),false);
  const fresh = {...old,...dispatchSessionObservation(session,old.generatedAt)};
  assert.equal(taskDispatchReady(job as never,fresh),true,
    'the durable queue sees completion before the next full catalog scan');
  assert.equal(taskDispatchReady(job as never,{...fresh,inFlight:true}),false);
  assert.equal(taskDispatchReady(job as never,{...fresh,paused:true}),false);
});
