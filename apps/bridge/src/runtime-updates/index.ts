import { closeSync, mkdirSync, openSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from '../config/runtime/paths';
import { latestRelease, trustedRelease, installRelease, verifyRelease, type Release } from './registry';
import { newerVersion, readState, runtimeVersion, saveState, validRuntime, versionRoot } from './selection.mjs';

type Options={root:string;stateDirectory:string;now?:()=>number;latest?:()=>Promise<unknown>;
  idle:()=>boolean;install?:(release:Release,directory:string)=>Promise<void>;
  verify?:(root:string)=>Promise<void>;activate?:(root:string)=>void};

/** Stage verified releases independently; activation waits until no request or decision is pending. */
export async function checkForRuntimeUpdate(options:Options):Promise<string|undefined> {
  mkdirSync(options.stateDirectory,{recursive:true,mode:0o700});
  const lock=join(options.stateDirectory,'install.lock');let fd:number;
  try {fd=openSync(lock,'wx',0o600);} catch {return undefined;}
  try {
    const release=await (options.latest??latestRelease)();
    const state=readState(options.stateDirectory);
    if(!trustedRelease(release) || !newerVersion(release.version,runtimeVersion(options.root))
      || state.rejectedVersion===release.version || (state.version && !newerVersion(release.version,state.version)))return;
    const candidate=versionRoot(options.stateDirectory,release.version);
    if(!validRuntime(candidate,options.stateDirectory,release.version)) {
      await (options.install??installRelease)(release,options.stateDirectory);
    }
    await (options.verify??verifyRelease)(candidate);
    if(!validRuntime(candidate,options.stateDirectory,release.version))throw Error('Runtime verification failed');
    if(!options.idle())return;
    saveState(options.stateDirectory,{root:candidate,version:release.version,
      previous:state.root?{root:state.root,version:state.version}:undefined});
    options.activate?.(candidate);return candidate;
  } finally {closeSync(fd);unlinkSync(lock);}
}

type LoopOptions={root:string;directory:string;idle:()=>boolean;check?:typeof checkForRuntimeUpdate;
  now?:()=>number;schedule?:typeof setTimeout;report?:()=>void;activate?:()=>void};

/** Check failure never stops sync; timers are owned and cancellation prevents another check. */
export function runtimeUpdateLoop(options:LoopOptions):()=>void {
  let stopped=false,timer:NodeJS.Timeout|undefined,lastCheck=0;
  const now=options.now??Date.now,schedule=options.schedule??setTimeout;
  const tick=async()=>{
    if(stopped)return;
    try {
      const lock=join(options.directory,'install.lock');
      try {if(now()-statSync(lock).mtimeMs>10*60_000)unlinkSync(lock);} catch { /* no stale lock */ }
      if(now()-lastCheck>=4*60*60_000) {
        await (options.check??checkForRuntimeUpdate)({root:options.root,stateDirectory:options.directory,idle:options.idle,
          activate:()=>options.activate?.()});
        lastCheck=options.idle()?now():0;
      }
    } catch {options.report?.();}
    finally {if(!stopped){timer=schedule(()=>void tick(),60_000);timer.unref();}}
  };
  timer=schedule(()=>void tick(),60_000);timer.unref();
  return ()=>{stopped=true;if(timer)clearTimeout(timer);};
}

/** Only the owned installed background monitor downloads updates; source checkouts stay fixed. */
export function startRuntimeUpdates(idle:()=>boolean):()=>void {
  if(process.env.GRANTTAP_DISABLE_AUTO_UPDATE==='1' || process.env.GRANTTAP_LOCAL==='1'
    || process.env.NODE_TEST_CONTEXT || !process.send)return ()=>{};
  const root=fileURLToPath(new URL('../../../../',import.meta.url));
  if(!root.includes('node_modules'))return ()=>{};
  return runtimeUpdateLoop({root,directory:join(configDir(),'runtime-updates'),idle,
    activate:()=>process.send?.({type:'granttap.runtime-update-ready'},()=>{}),
    report:()=>process.stderr.write('[granttap-mcp] Automatic runtime update deferred; current version retained.\n')});
}
