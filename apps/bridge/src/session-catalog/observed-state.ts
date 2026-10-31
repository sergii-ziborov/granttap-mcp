import {statSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import type {SessionInfo, SessionsStatus} from '../../../../packages/protocol/schema';
import {localTaskTransfers} from '../task-transfer';
import {nativeTranscriptSource} from '../sessions/native-source';
import {claudeLogPath} from '../sessions/scan/claude/shared';
import {previousNativeLines} from '../transcript-history/native-lines';
import {observeClaudeTurn,claudeTurnState,type ClaudeTurnClock} from '../sessions/scan/claude/turn-state';
import {observeCodexTurn,codexTurnState,type CodexTurnClock} from '../sessions/scan/codex/turn-state';
import {ts} from '../sessions/support/common';
import {grokResumeActivity} from '../providers/grok-activity';
import {cursorConversationSession} from '../sessions/cursor';
import {nativePromptDigest, type NativeCompletionProof} from '../reply/native-completion';

type NativeClock={revision:string;identity:string;bytes:number;lastActivityAt:number;claude:ClaudeTurnClock;codex:CodexTurnClock;
  promptAt:number;promptDigests:string[];completion?:NativeCompletionProof};
const clocks=new Map<string,NativeClock>();
export type SessionObservation={session:SessionInfo;revision:string;completion?:NativeCompletionProof};

/** Discovery may have started before an open chat finished its turn. Recheck before publication. */
export function refreshObservedCatalog(status: SessionsStatus): SessionsStatus {
  const refresh = (session: SessionInfo) => observeSessionExecution(session)?.session ?? session;
  return {...status, sessions: status.sessions.map(refresh), history: status.history?.map(refresh)};
}

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
      const identity = `${stat.dev}:${stat.ino}`;
      const append = clock?.identity === identity && stat.size > clock.bytes;
      clock={revision,identity,bytes:stat.size,lastActivityAt:0,claude:append?{...clock!.claude}:{},codex:{},
        promptAt:append?clock!.promptAt:0,promptDigests:append?clock!.promptDigests:[],completion:append?clock!.completion:undefined};
      for(const line of window.lines){
        let row;try{row=JSON.parse(line.text)}catch{continue}
        if(row.isSidechain===true||row.sessionId&&row.sessionId!==native.sessionId)continue;
        clock.lastActivityAt=Math.max(clock.lastActivityAt,ts(row.timestamp));
        if(native.agent==='claude'){
          observeClaudeTurn(row,clock.claude);
          const content=row.message?.content;
          const texts=typeof content==='string'?[content]:Array.isArray(content)?content.filter(b=>b?.type==='text'&&typeof b.text==='string').map(b=>b.text):[];
          if(row.type==='user'&&texts.length){clock.promptAt=ts(row.timestamp);clock.promptDigests=[...texts,texts.join('\n')].map(nativePromptDigest)}
          if(row.type==='assistant'&&clock.claude.turnEnded)clock.completion={nativeSessionId:native.sessionId,
            promptAt:clock.promptAt,promptDigests:clock.promptDigests,completedAt:ts(row.timestamp),text:texts.join('\n')};
        }else observeCodexTurn(row,clock.codex);
      }
      clocks.delete(key);clocks.set(key,clock);
      while(clocks.size>256)clocks.delete(clocks.keys().next().value!);
    }
    const at=Math.max(input.lastActivityAt,clock!.lastActivityAt);
    const state=native.agent==='claude'?claudeTurnState(clock!.claude,at,input.state)
      :clock!.codex.startedAt||clock!.codex.endedAt?codexTurnState(clock!.codex,at):input.state;
    return {session:{...input,state,lastActivityAt:at},revision:`${revision}:${state}`,
      ...(native.agent==='claude'&&clock!.claude.turnEnded&&clock!.completion?{completion:clock!.completion}:{})};
  }catch{return;}
}
