import type { UpdateDrain } from './drain';

/**
 * Only the launcher's private IPC channel can ask the owned service to drain for an update. It asks while a
 * newer runtime is selected, so a busy monitor with a drain stops starting new work until it can answer.
 */
export function runtimeUpdateReadiness(idle:()=>boolean,drain?:Pick<UpdateDrain,'request'|'handoff'>):()=>void {
  const listener=(message:unknown)=>{
    if((message as {type?:string})?.type!=='granttap.runtime-update-check')return;
    if(!idle()) {drain?.request();return;}
    drain?.handoff();
    process.send?.({type:'granttap.runtime-update-ready'},()=>{});
  };
  process.on('message',listener);
  process.send?.({type:'granttap.runtime-healthy'},()=>{});
  return ()=>{process.off('message',listener);};
}

/** Count async work until completion; an update cannot interrupt a partially delivered command. */
export function runtimeWorkTracker(blocked:()=>boolean) {
  let count=0;
  return {
    idle:()=>count===0 && !blocked(),
    run:async<T>(work:()=>Promise<T>):Promise<T>=>{
      count++;
      try {return await work();} finally {count--;}
    },
  };
}
