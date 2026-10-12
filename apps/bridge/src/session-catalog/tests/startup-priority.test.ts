import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { saveRuntimeConfig } from "../../config";
import { rememberPublishedCatalog } from "..";
import { startSessionMonitor } from "../../monitor";
import type { Payload } from "../../../../../packages/protocol/schema";

test("a saved transcript cannot hold the first fresh catalog behind its transfer", async t => {
  const root = mkdtempSync("/tmp/granttap-startup-priority-");
  const names = ["GRANTTAP_CONFIG_DIR", "GRANTTAP_CLAUDE_PROJECTS_DIR", "GRANTTAP_CODEX_SESSIONS_DIR",
    "GRANTTAP_CODEX_DIR", "GRANTTAP_CURSOR_TRANSCRIPTS_DIR", "GRANTTAP_GROK_SESSIONS_DIR"];
  const prior = Object.fromEntries(names.map(n => [n, process.env[n]]));
  for (const name of names) process.env[name] = root;
  mkdirSync(join(root, "project"));
  writeFileSync(join(root,"project","saved.jsonl"), JSON.stringify({ type:"user", sessionId:"saved",
    timestamp:new Date().toISOString(), cwd:root, message:{role:"user",content:"Saved request"} })+"\n");
  saveRuntimeConfig({meshEnabled:false,providerSettings:{claude:true,codex:false,cursor:false,grok:false}});
  let release!:()=>void;
  const held = new Promise<void>(resolve=>{release=resolve;});
  const sent: Payload[] = [];
  const client = {room:"isolated",isConnected:true,onMessage:()=>()=>{},setSessionKey:()=>{},
    send:async(payload:Payload)=>{sent.push(payload);},sendSession:async()=>held};
  rememberPublishedCatalog(client as never,{type:"sessions.status",machine:"Test",
    sessions:[{sessionId:"saved",agent:"claude",state:"idle",startedAt:1,lastActivityAt:2,
      tokensSession:0,tokensLastTurn:0}],generatedAt:1});
  const monitor = startSessionMonitor(client as never);
  t.after(()=>{release();monitor.close();for(const name of names){
    if(prior[name]==null)delete process.env[name];else process.env[name]=prior[name];}
    rmSync(root,{recursive:true,force:true});});
  let timer:NodeJS.Timeout|undefined;
  try {
    await Promise.race([monitor.publish(),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error("A saved head blocked the fresh catalog")),750);})]);
    assert.ok(sent.some(p=>p.type==="sessions.status"&&p.generatedAt>1));
  } finally {clearTimeout(timer);release();}
});
