import assert from 'node:assert/strict';
import {appendFileSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {restoreNativeTranscriptSource} from '../../../sessions';
import {observeSessionExecution} from '../../observed-state';
import type {SessionInfo} from '../../../../../../packages/protocol/schema';

test('an open chat waiting on its own background work or a subscription limit says so, and stops saying it after',t=>{
  const root=mkdtempSync(join(tmpdir(),'observed-waits-')),logs=join(root,'logs');
  mkdirSync(join(logs,'fixture-project'),{recursive:true});
  const prior=process.env.GRANTTAP_CLAUDE_PROJECTS_DIR;process.env.GRANTTAP_CLAUDE_PROJECTS_DIR=logs;
  t.after(()=>{if(prior===undefined)delete process.env.GRANTTAP_CLAUDE_PROJECTS_DIR;else process.env.GRANTTAP_CLAUDE_PROJECTS_DIR=prior;
    rmSync(root,{recursive:true,force:true});});
  const now=Date.now(),file=join(logs,'fixture-project','waiting-chat.jsonl');
  const row=(type:string,at:number,message?:unknown,extra:Record<string,unknown>={})=>JSON.stringify({type,
    sessionId:'waiting-chat',timestamp:new Date(at).toISOString(),message,...extra})+'\n';
  writeFileSync(file,row('assistant',now-9_000,{role:'assistant',stop_reason:'tool_use',
    content:[{type:'tool_use',id:'toolu_fixture',name:'Bash',input:{command:'synthetic',run_in_background:true}}]})
    +row('user',now-8_000,{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_fixture',
      content:'Command running in background with ID: bfixture.'}]})
    +row('assistant',now-7_000,{role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:'Waiting.'}]}));
  const chat:SessionInfo={sessionId:'waiting-chat',agent:'claude',cwd:root,state:'idle',startedAt:now-60_000,
    lastActivityAt:now-7_000,tokensSession:0,tokensLastTurn:0,backgroundTasks:3};
  assert.equal(restoreNativeTranscriptSource(chat,file),true);

  const waiting=observeSessionExecution(chat);
  assert.equal(waiting?.session.state,'idle');
  assert.equal(waiting?.session.backgroundTasks,1,'the tail, not an older reading, says what is outstanding');

  appendFileSync(file,row('queue-operation',now-2_000,undefined,{operation:'enqueue',
    content:'<task-notification><tool-use-id>toolu_fixture</tool-use-id><status>completed</status></task-notification>'})
    +row('assistant',now-1_000,{role:'assistant',model:'<synthetic>',stop_reason:'stop_sequence',
      content:[{type:'text',text:"You've hit your 5-hour limit"}]},{isApiErrorMessage:true,
      quotaLimits:{status:'rejected',resetsAt:Math.floor(now/1_000)+3_600,rateLimitType:'five_hour'}}));
  const limited=observeSessionExecution(chat);
  assert.equal(limited?.session.backgroundTasks,undefined);
  assert.equal(limited?.session.usageLimit?.resetsAt,(Math.floor(now/1_000)+3_600)*1_000);
  assert.notEqual(limited?.revision,waiting?.revision,'the phone hears about the change');
});
