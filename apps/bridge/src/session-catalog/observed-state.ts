import {statSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import type {SessionInfo} from '../../../../packages/protocol/schema';
import {localTaskTransfers} from '../task-transfer';
import {nativeTranscriptSource} from '../sessions/native-source';
import {claudeLogPath} from '../sessions/scan/claude/shared';
import {previousNativeLines} from '../transcript-history/native-lines';
import {observeClaudeTurn,claudeTurnState,type ClaudeTurnClock} from '../sessions/scan/claude/turn-state';
import {observeCodexTurn,codexTurnState,type CodexTurnClock} from '../sessions/scan/codex/turn-state';
import {ts} from '../sessions/support/common';
import {grokResumeActivity} from '../providers/grok-activity';
import {cursorConversationSession} from '../sessions/cursor';

type NativeClock={revision:string;lastActivityAt:number;claude:ClaudeTurnClock;codex:CodexTurnClock};
const clocks=new Map<string,NativeClock>();
export type SessionObservation={session:SessionInfo;revision:string};

/** A known chat uses one bounded native tail, never discovery across unrelated projects. */
export function observeSessionExecution(input:SessionInfo):SessionObservation|undefined {
  const native=localTaskTransfers().nativeSession(input);
  if(native.agent==='cursor'){
    const current=cursorConversationSession(native.sessionId);
    return current?{session:{...input,state:current.state,lastActivityAt:current.lastActivityAt},revision:`${current.lastActivityAt}:${current.state}`}:undefined;
  }
  if(native.agent==='grok'){
    const live=grokResumeActivity(native);
    if(!native.cwd||!live)return;
    const root=process.env.GRANTTAP_GROK_SESSIONS_DIR??join(process.env.GROK_HOME??join(homedir(),'.grok'),'sessions');
    try{
      const stat=statSync(join(root,encodeURIComponent(native.cwd),native.sessionId,'updates.jsonl'));
      return {session:{...input,state:live.state,lastActivityAt:Math.max(input.lastActivityAt,live.updatedAt)},revision:`${stat.ino}:${stat.size}:${stat.mtimeMs}:${live.state}`};
    }catch{return;}
  }
  if(native.agent!=='claude'&&native.agent!=='codex')return;
  const path=nativeTranscriptSource(native)??(native.agent==='claude'?claudeLogPath(native.sessionId):undefined);
  if(!path)return;
  try{
    const stat=statSync(path),revision=`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    const key=`${native.agent}:${native.sessionId}:${path}`;
    let clock=clocks.get(key);
    if(clock?.revision!==revision){
      const window=previousNativeLines(path,native.sessionId);if(!window)return;
      clock={revision,lastActivityAt:0,claude:{},codex:{}};
      for(const line of window.lines){
        let row;try{row=JSON.parse(line.text)}catch{continue}
        if(row.isSidechain===true||row.sessionId&&row.sessionId!==native.sessionId)continue;
        clock.lastActivityAt=Math.max(clock.lastActivityAt,ts(row.timestamp));
        if(native.agent==='claude')observeClaudeTurn(row,clock.claude);else observeCodexTurn(row,clock.codex);
      }
      clocks.delete(key);clocks.set(key,clock);
      while(clocks.size>256)clocks.delete(clocks.keys().next().value!);
    }
    const at=Math.max(input.lastActivityAt,clock!.lastActivityAt);
    const state=native.agent==='claude'?claudeTurnState(clock!.claude,at,input.state)
      :clock!.codex.startedAt||clock!.codex.endedAt?codexTurnState(clock!.codex,at):input.state;
    return {session:{...input,state,lastActivityAt:at},revision:`${revision}:${state}`};
  }catch{return;}
}
