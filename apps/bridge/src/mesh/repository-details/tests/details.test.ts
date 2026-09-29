import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryDetails } from "../index";
import { observedCodexWorktree, workdirsFromCodexCall } from "../../../sessions/scan/codex/shared";
import type { MeshSnapshot } from "../../../../../../packages/protocol/schema";
import { MeshSnapshot as SnapshotSchema } from "../../../../../../packages/protocol/schema";

function checkout() {
  const path = mkdtempSync(join(tmpdir(), "granttap-repository-details-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", path, ...args], {encoding:"utf8"}).trim();
  git("init", "-q");
  writeFileSync(join(path, "file.txt"), "first\n");
  git("add", ".");
  git("-c", "user.name=Fixture Contributor", "-c", "user.email=fixture@example.test", "commit", "-q", "-m", "First commit");
  git("remote", "add", "origin", "https://username:password@example.test/team/app.git");
  return { path, git };
}

function snapshot(path: string): MeshSnapshot {
  return {type:"mesh.snapshot", sessionId:"mesh", projectId:"mesh", publisherEndpointId:"mac",
    project:{projectId:"mesh",name:"Fixture",canonicalRepositoryId:"local:"+path,createdAt:1},
    bindings:[{bindingId:"local",projectId:"mesh",endpointId:"mac",repositoryId:"local:"+path,
      displayName:"Fixture",localPathHint:path,available:true}],
    tasks:[],executions:[],claims:[],dependencies:[],events:[],generatedAt:1};
}

test("repository details report real bounded Git history and canonical identity without credentials", async () => {
  const {path,git}=checkout();
  const reports=await repositoryDetails(snapshot(path),"mac");
  assert.equal(reports.length,1);
  const report=reports[0]!;
  assert.equal(report.status,"ready");
  assert.equal(report.canonicalRepositoryId,"example.test/team/app");
  assert.equal(report.revision,git("rev-parse","HEAD"));
  assert.equal(report.commitCount,1);
  assert.equal(report.commits[0]?.subject,"First commit");
  assert.deepEqual(report.contributors,[{name:"Fixture Contributor",commits:1}]);
  assert.equal(JSON.stringify(report).includes("password"),false);
  writeFileSync(join(path,"file.txt"),"second\n");
  const changed=await repositoryDetails(snapshot(path),"mac");
  assert.equal(changed[0]?.dirty,true);
});

test("metadata cannot read foreign or unavailable bindings and missing Git remains explicit", async () => {
  const path=mkdtempSync(join(tmpdir(),"granttap-no-git-"));
  const value=snapshot(path);
  value.bindings!.push({...value.bindings![0]!,bindingId:"foreign",projectId:"other"});
  value.bindings!.push({...value.bindings![0]!,bindingId:"offline",endpointId:"offline"});
  const reports=await repositoryDetails(value,"mac");
  assert.equal(reports.length,1);
  assert.equal(reports[0]?.status,"not_git");
  assert.equal(reports[0]?.commitCount,undefined);
  assert.deepEqual(reports[0]?.commits,[]);
});

test("sustained command execution detects a repository outside the Git workspace where the chat began", () => {
  const first=checkout(), target=checkout();
  assert.equal(observedCodexWorktree(first.path,[target.path,target.path]),undefined);
  assert.equal(observedCodexWorktree(first.path,Array(8).fill(target.path)),target.git("rev-parse","--show-toplevel"));
  assert.equal(observedCodexWorktree(first.path,[target.path,first.path,target.path,first.path]),undefined);
  const call={type:"response_item",payload:{type:"function_call",name:"exec_command",
    arguments:JSON.stringify({cmd:"git status",workdir:target.path})}};
  assert.deepEqual(workdirsFromCodexCall(call),[target.path]);
});

test("repository reports survive the encrypted snapshot contract and reject foreign publishers", async () => {
  const {path}=checkout();
  const value=snapshot(path);
  const reports=await repositoryDetails(value,"mac");
  assert.equal(SnapshotSchema.parse({...value,repositoryDetails:reports}).repositoryDetails?.length,1);
  assert.equal(SnapshotSchema.safeParse({...value,repositoryDetails:[{...reports[0],projectId:"foreign"}]}).success,false);
  assert.equal(SnapshotSchema.safeParse({...value,repositoryDetails:[{...reports[0],endpointId:"other"}]}).success,false);
  assert.equal(SnapshotSchema.safeParse({...value,repositoryDetails:[...reports,...reports]}).success,false);
});

test("empty checkouts and missing checkout paths have different explicit states", async () => {
  const path=mkdtempSync(join(tmpdir(),"granttap-empty-git-"));
  execFileSync("git",["init","-q",path]);
  const empty=(await repositoryDetails(snapshot(path),"mac"))[0]!;
  assert.equal(empty.status,"ready");
  assert.equal(empty.commitCount,0);
  assert.equal(empty.contributorCount,0);
  assert.equal(empty.revision,undefined);
  const missing=(await repositoryDetails(snapshot(join(path,"missing")),"mac"))[0]!;
  assert.equal(missing.status,"unavailable");
  assert.equal(missing.commitCount,undefined);
});

test("Git history is bounded while total counts remain correct and no emails are exposed", async () => {
  const {path,git}=checkout();
  for (let i=0;i<10;i++) {
    git("-c","user.name=Fixture Contributor","-c","user.email=fixture@example.test", "commit","--allow-empty","-q","-m",`Commit ${i}`);
  }
  const report=(await repositoryDetails(snapshot(path),"mac"))[0]!;
  assert.equal(report.commits.length,8);
  assert.equal(report.commitCount,11);
  assert.equal(report.contributors[0]?.commits,11);
  assert.equal(JSON.stringify(report).includes("fixture@example.test"),false);
});
