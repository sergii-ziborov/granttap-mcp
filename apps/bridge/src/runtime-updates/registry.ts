import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stableVersion, validRuntime, versionRoot } from './selection.mjs';

export type Release = {name:string;version:string;dist:{integrity:string;tarball:string}};
const registry='https://registry.npmjs.org';
export function trustedRelease(value:unknown):value is Release {
  const r=value as Release|undefined;
  return r?.name==='granttap-mcp' && stableVersion(r.version)
    && typeof r.dist?.integrity==='string' && /^sha512-[A-Za-z0-9+/]{86}==$/.test(r.dist.integrity)
    && r.dist.tarball===`${registry}/granttap-mcp/-/granttap-mcp-${r.version}.tgz`;
}
/** Registry metadata is bounded, timed, and never changes the installed runtime by itself. */
export async function latestRelease():Promise<unknown> {
  const response=await fetch(registry+'/granttap-mcp/latest',{signal:AbortSignal.timeout(10_000),redirect:'error'});
  if(!response.ok || !response.body) throw Error('Runtime registry unavailable');
  const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
  try { for(;;) {const {done,value}=await reader.read();if(done)break;
    size+=value.byteLength;if(size>262_144)throw Error('Runtime metadata exceeds limit');chunks.push(value);
  } } finally {await reader.cancel();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function run(command:string,args:string[],timeoutMs=180_000,env:NodeJS.ProcessEnv=process.env):Promise<void> {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{env,stdio:'ignore',windowsHide:true});let done=false;
    const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve();};
    const timer=setTimeout(()=>{child.kill();finish(Error('Runtime update command timed out'));},timeoutMs);
    child.once('error',()=>finish(Error('Runtime update command could not start')));
    child.once('exit',code=>finish(code===0?undefined:Error('Runtime update command failed')));
  });
}
function npmCli():string {
  const bin=dirname(process.execPath);
  for(const path of [join(bin,'npm'),join(bin,'node_modules','npm','bin','npm-cli.js'),
    join(bin,'..','lib','node_modules','npm','bin','npm-cli.js')]) {
    if(existsSync(path) && !path.endsWith('.cmd'))return realpathSync(path);
  }
  throw Error('The installed Node runtime has no npm updater');
}
/** npm verifies registry integrity and Node compatibility in a version-specific, isolated prefix. */
export async function installRelease(release:Release,directory:string,runner=run):Promise<void> {
  await runner(process.execPath,[npmCli(),'install','--prefix',join(directory,'versions',release.version),
    '--registry',registry,'--ignore-scripts','--engine-strict','--omit=dev','--no-audit','--no-fund',
    '--save-exact',`granttap-mcp@${release.version}`]);
  const lock=JSON.parse(readFileSync(join(directory,'versions',release.version,'package-lock.json'),'utf8'));
  const installed=lock.packages?.['node_modules/granttap-mcp'];
  if(installed?.version!==release.version || installed?.integrity!==release.dist.integrity
    || installed?.resolved!==release.dist.tarball || !validRuntime(versionRoot(directory,release.version),directory,release.version)) {
    throw Error('Installed runtime identity or registry integrity did not match');
  }
}
export async function verifyRelease(root:string):Promise<void> {
  await run(process.execPath,[join(root,'bin','granttap-mcp.mjs'),'--help'],15_000,
    {...process.env,GRANTTAP_DISABLE_AUTO_UPDATE:'1'});
  // Validate the launcher without starting services or reading the live pairing.
  await run(process.execPath,['--check',join(root,'bin','granttap-mcp.mjs')],15_000);
}
