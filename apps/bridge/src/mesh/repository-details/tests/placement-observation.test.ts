import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeFile } from "../../../sessions/scan/claude/parse";
import { workdirsFromCodexCall } from "../../../sessions/scan/codex/shared";

function checkout() {
  const path=mkdtempSync(join(tmpdir(),"granttap-placement-"));
  execFileSync("git",["init","-q",path]);
  return path;
}

test("Claude detects sustained structured edits in another checkout without using the chat title", () => {
  const source=checkout(), target=checkout(), file=join(source,"fixture.jsonl");
  const base={sessionId:"fixture",cwd:source,timestamp:new Date().toISOString()};
  const lines=[{...base,type:"user",message:{role:"user",content:"Stay in original project"}},
    ...[1,2,3].map(i=>({...base,type:"assistant",message:{role:"assistant",content:[
      {type:"tool_use",id:`edit-${i}`,name:"Edit",input:{file_path:join(target,`file-${i}.ts`)}}]}}))];
  writeFileSync(file,lines.map(line=>JSON.stringify(line)).join("\n"));
  const result=parseClaudeFile(file);
  assert.equal(result?.session.cwd,source);
  assert.equal(result?.session.worktree,realpathSync(target));
  assert.equal(result?.session.title,"Stay in original project");
});

test("literal shell working-directory changes supersede exec cwd while prose is not an observation", () => {
  const call=(cmd:string) => ({type:"response_item",payload:{type:"function_call",name:"exec_command",
    arguments:JSON.stringify({cmd,workdir:"/original"})}});
  assert.deepEqual(workdirsFromCodexCall(call("cd '/actual repo' && git status")),["/actual repo"]);
  assert.deepEqual(workdirsFromCodexCall(call("git -C /actual status")),["/actual"]);
  assert.deepEqual(workdirsFromCodexCall(call("echo 'cd /fiction && run'")),["/original"]);
  assert.deepEqual(workdirsFromCodexCall({type:"event_msg",payload:{message:"workdir: '/fiction'"}}),[]);
});
