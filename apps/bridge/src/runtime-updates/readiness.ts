/** Only the launcher's private IPC channel can ask the owned service to drain for an update. */
export function runtimeUpdateReadiness(idle:()=>boolean):()=>void {
  const listener=(message:unknown)=>{
    if((message as {type?:string})?.type==='granttap.runtime-update-check' && idle()) {
      process.send?.({type:'granttap.runtime-update-ready'},()=>{});
    }
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
