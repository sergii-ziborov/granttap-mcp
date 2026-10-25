import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installRelease, latestRelease, run, trustedRelease, type Release } from '../registry';
const release:Release={name:'granttap-mcp',version:'0.8.102',dist:{tarball:'https://registry.npmjs.org/granttap-mcp/-/granttap-mcp-0.8.102.tgz',integrity:'sha512-'+Buffer.alloc(64,3).toString('base64')}};

test('only the official stable package with full integrity is eligible',()=>{
  assert.equal(trustedRelease(release),true);
  for(const value of [null,{}, {...release,name:'other'}, {...release,version:'01.2.3'},
    {...release,dist:{...release.dist,integrity:'sha512-short'}},
    {...release,dist:{...release.dist,tarball:'https://registry.npmjs.org/other/-/other.tgz'}}])assert.equal(trustedRelease(value),false);
});
test('registry responses are bounded and HTTP failures cannot become release metadata',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify(release)));
  assert.deepEqual(await latestRelease(),release);
  globalThis.fetch=async()=>new Response('',{status:503});await assert.rejects(latestRelease(),/unavailable/);
  globalThis.fetch=async()=>new Response('x'.repeat(262145));await assert.rejects(latestRelease(),/limit/);
  globalThis.fetch=async()=>new Response('invalid');await assert.rejects(latestRelease(),SyntaxError);
});
test('the updater command has bounded failure and never returns success after a spawn error',async()=>{
  await run(process.execPath,['-e','process.exit(0)']);
  await assert.rejects(run(process.execPath,['-e','process.exit(1)']),/failed/);
  await assert.rejects(run('/nonexistent/granttap-npm',[]),/could not start/);
  await assert.rejects(run(process.execPath,['-e','setTimeout(()=>{},10000)'],20),/timed out/);
});

test('isolated npm staging requires the same exact registry integrity before it can be activated',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'granttap-update-install-'));let calls=0;
  const runner=async(_command:string,args:string[])=>{
    calls++;assert.ok(args.includes('--ignore-scripts'));assert.ok(args.includes('--engine-strict'));
    assert.ok(args.includes('granttap-mcp@0.8.102'));
    const prefix=join(directory,'versions',release.version),root=join(prefix,'node_modules','granttap-mcp');
    mkdirSync(join(root,'bin'),{recursive:true});writeFileSync(join(root,'package.json'),JSON.stringify({name:release.name,version:release.version}));
    writeFileSync(join(root,'bin','granttap-mcp.mjs'),'');
    writeFileSync(join(prefix,'package-lock.json'),JSON.stringify({packages:{'node_modules/granttap-mcp':{version:release.version,integrity:release.dist.integrity,resolved:release.dist.tarball}}}));
  };
  await installRelease(release,directory,runner);assert.equal(calls,1);
  await assert.rejects(installRelease(release,directory,async(c,a)=>{await runner(c,a);
    const p=join(directory,'versions',release.version,'package-lock.json');writeFileSync(p,JSON.stringify({packages:{}}));}),/integrity/);
});

test('staged launcher smoke runs in its own process and a broken launcher fails verification',async()=>{
  const {verifyRelease}=await import('../registry');
  const root=mkdtempSync(join(tmpdir(),'granttap-update-smoke-'));mkdirSync(join(root,'bin'));
  writeFileSync(join(root,'bin','granttap-mcp.mjs'),'process.exit(0);');await verifyRelease(root);
  writeFileSync(join(root,'bin','granttap-mcp.mjs'),'throw Error("broken package");');await assert.rejects(verifyRelease(root),/failed/);
});
