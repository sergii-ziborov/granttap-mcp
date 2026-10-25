import { selectedRuntime, rollbackRuntime } from './selection.mjs';

/** Monitor only the child started by this launcher; external providers are never stopped. */
export function superviseRuntime(child, options) {
  const {bundled,root,directory}=options;
  const started=(options.now??Date.now)();let healthy=root===bundled,stopped=false;
  const read=()=>selectedRuntime(bundled,directory);
  const changed=()=>read()!==root;
  const stop=()=>{if(stopped)return;stopped=true;clearInterval(timer);child.off('message',onMessage);};
  const onMessage=message=>{
    if(message?.type==='granttap.runtime-healthy')healthy=true;
    if(message?.type==='granttap.runtime-update-ready' && changed()) {stop();child.kill('SIGTERM');}
  };
  const tick=()=>{
    if(stopped)return;
    if(!healthy && (options.now??Date.now)()-started>120_000) {
      rollbackRuntime(bundled,directory,root);stop();child.kill('SIGTERM');return;
    }
    if(changed() && child.connected)child.send({type:'granttap.runtime-update-check'},()=>{});
  };
  const timer=(options.schedule??setInterval)(tick,10_000);timer.unref?.();child.on('message',onMessage);
  return {stop,onExit:(code,signal)=>{
    if(!stopped && !healthy && code!==0 && !['SIGTERM','SIGINT'].includes(signal)) {
      rollbackRuntime(bundled,directory,root);
    }
    stop();
  }};
}
