import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const stableVersion = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
export function newerVersion(candidate, current) {
  if (!stableVersion(candidate) || !stableVersion(current)) return false;
  const a=candidate.split('.').map(Number), b=current.split('.').map(Number);
  for(let i=0;i<3;i++) { if(a[i]!==b[i]) return a[i]>b[i]; }
  return false;
}
export function readState(directory) {
  try { return JSON.parse(readFileSync(join(directory,'active.json'),'utf8')); } catch { return {}; }
}
export function saveState(directory, state) {
  mkdirSync(directory,{recursive:true,mode:0o700});
  const path=join(directory,'active.json'), temporary=path+'.'+process.pid+'.tmp';
  writeFileSync(temporary,JSON.stringify(state),{mode:0o600});renameSync(temporary,path);
}
export function runtimeVersion(root) {
  const p=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  if(p.name!=='granttap-mcp' || !stableVersion(p.version)) throw Error('Invalid GrantTap runtime package');
  return p.version;
}
export function versionRoot(directory, version) {
  return join(directory,'versions',version,'node_modules','granttap-mcp');
}
export function validRuntime(root, directory, version) {
  try { return stableVersion(version) && resolve(root)===resolve(versionRoot(directory,version))
    && runtimeVersion(root)===version && existsSync(join(root,'bin','granttap-mcp.mjs')); } catch { return false; }
}
/** The stable launcher accepts only a verified, newer package inside its private version cache. */
export function selectedRuntime(bundled, directory) {
  const state=readState(directory);
  return validRuntime(state.root,directory,state.version) && newerVersion(state.version,runtimeVersion(bundled))
    ? state.root : bundled;
}
/** A new background service that exits during startup restores the last working selection. */
export function rollbackRuntime(bundled, directory, failedRoot) {
  const state=readState(directory);
  if(!state.version || (failedRoot && state.root!==failedRoot)) return false;
  const rejectedVersion=state.version, previous=state.previous;
  if(previous && validRuntime(previous.root,directory,previous.version)) {
    saveState(directory,{...previous,rejectedVersion});
  } else saveState(directory,{rejectedVersion});
  return true;
}
