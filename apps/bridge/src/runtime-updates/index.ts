import { closeSync, mkdirSync, openSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from '../config/runtime/paths';
import { latestRelease, trustedRelease, installRelease, verifyRelease, type Release } from './registry';
import { newerVersion, readState, runtimeVersion, saveState, validRuntime, versionRoot } from './selection.mjs';
import { automaticUpdatesAllowed } from './preferences/storage.mjs';
import { HOLD_POLL_MS, type UpdateDrain } from './drain';
export { runtimeUpdateSettings, setRuntimeAutoUpdate } from './preferences';

type Options={root:string;stateDirectory:string;manual?:boolean;now?:()=>number;latest?:()=>Promise<unknown>;
  idle:()=>boolean;install?:(release:Release,directory:string)=>Promise<void>;
  verify?:(root:string)=>Promise<void>;activate?:(root:string)=>void;drain?:UpdateDrain};

/** An install killed mid-way (a reboot, a full disk) leaves its lock behind; ten minutes covers a real install. */
function removeStaleLock(lock:string,now:number):void {
  try {if(now-statSync(lock).mtimeMs>10*60_000)unlinkSync(lock);} catch { /* no stale lock */ }
}

/**
 * Stage releases independently; automatic activation waits until no request or decision is pending. Messages
 * keep arriving, so that moment may not come for hours. A monitor with a drain therefore starts the staged
 * release once to verify it, then holds new work until the running work has ended; see `UpdateDrain`. Without
 * a drain a busy check does nothing, since each one would start two Node processes. A phone's explicit update
 * is one check, and a hung run is exactly what it may be replacing, so it verifies and selects at once; the
 * selected version starts with the next MCP restart.
 */
export async function checkForRuntimeUpdate(options:Options):Promise<string|undefined> {
  const allowed=()=>options.manual===true || automaticUpdatesAllowed(options.stateDirectory);
  const ready=()=>(options.manual===true || options.idle()) && allowed();
  const drain=options.manual===true?undefined:options.drain;
  if(!allowed())return;
  mkdirSync(options.stateDirectory,{recursive:true,mode:0o700});
  const lock=join(options.stateDirectory,'install.lock');let fd:number;
  removeStaleLock(lock,(options.now??Date.now)());
  try {fd=openSync(lock,'wx',0o600);} catch {return undefined;}
  try {
    const release=await (options.latest??latestRelease)();
    if(!allowed())return;
    const state=readState(options.stateDirectory);
    if(!trustedRelease(release) || !newerVersion(release.version,runtimeVersion(options.root))
      || state.rejectedVersion===release.version || (state.version && !newerVersion(release.version,state.version)))return;
    const candidate=versionRoot(options.stateDirectory,release.version);
    if(!validRuntime(candidate,options.stateDirectory,release.version)) {
      await (options.install??installRelease)(release,options.stateDirectory);
    }
    const verify=async()=>{
      await (options.verify??verifyRelease)(candidate);
      if(!validRuntime(candidate,options.stateDirectory,release.version))throw Error('Runtime verification failed');
    };
    if(!ready() && !(drain && allowed()))return;
    if(drain) {if(!await drain.verified(release.version,verify))return;}
    else await verify();
    if(!ready()) {if(allowed())drain?.request(release.version);return;}
    saveState(options.stateDirectory,{root:candidate,version:release.version,
      previous:state.root?{root:state.root,version:state.version}:undefined});
    drain?.handoff(release.version);
    options.activate?.(candidate);return candidate;
  } finally {closeSync(fd);unlinkSync(lock);}
}

type LoopOptions={root:string;directory:string;idle:()=>boolean;check?:typeof checkForRuntimeUpdate;
  now?:()=>number;schedule?:typeof setTimeout;report?:()=>void;activate?:()=>void;
  latest?:()=>Promise<unknown>;drain?:UpdateDrain};

/**
 * Check failure never stops sync; timers are owned and cancellation prevents another check. While new work is
 * held for a staged release, a five-second pass only asks whether the running work has ended, and the pass
 * that finds it ended selects the release it already knows instead of asking the registry first.
 */
export function runtimeUpdateLoop(options:LoopOptions):()=>void {
  let stopped=false,timer:NodeJS.Timeout|undefined,lastCheck=0,known:unknown;
  const now=options.now??Date.now,schedule=options.schedule??setTimeout,drain=options.drain;
  const latest=async()=>drain?.holding() && known?known:(known=await (options.latest??latestRelease)());
  const tick=async()=>{
    if(stopped)return;
    try {
      if(!automaticUpdatesAllowed(options.directory)){lastCheck=0;drain?.cancel();return;}
      removeStaleLock(join(options.directory,'install.lock'),now());
      if(drain?.holding()?options.idle():now()-lastCheck>=4*60*60_000) {
        await (options.check??checkForRuntimeUpdate)({root:options.root,stateDirectory:options.directory,idle:options.idle,
          latest,drain,activate:()=>options.activate?.()});
        lastCheck=options.idle()?now():0;
      }
    } catch {drain?.failed();options.report?.();}
    finally {if(!stopped){timer=schedule(()=>void tick(),drain?.holding()?HOLD_POLL_MS:60_000);timer.unref();}}
  };
  timer=schedule(()=>void tick(),60_000);timer.unref();
  return ()=>{stopped=true;if(timer)clearTimeout(timer);};
}

/** Only the owned installed background monitor downloads updates; source checkouts stay fixed. */
export function startRuntimeUpdates(idle:()=>boolean,drain?:UpdateDrain):()=>void {
  if(process.env.GRANTTAP_DISABLE_AUTO_UPDATE==='1' || process.env.GRANTTAP_LOCAL==='1'
    || process.env.NODE_TEST_CONTEXT || !process.send)return ()=>{};
  const root=fileURLToPath(new URL('../../../../',import.meta.url));
  if(!root.includes('node_modules'))return ()=>{};
  return runtimeUpdateLoop({root,directory:join(configDir(),'runtime-updates'),idle,drain,
    activate:()=>process.send?.({type:'granttap.runtime-update-ready'},()=>{}),
    report:()=>process.stderr.write('[granttap-mcp] Automatic runtime update deferred; current version retained.\n')});
}
