import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProjectRepositoryDetails, type MeshSnapshot, type ProjectBindingSummary } from "../../../../../packages/protocol/schema";
import { canonicalRepositoryIdentity } from "../identity";

const run = promisify(execFile);
async function git(path: string, args: string[]): Promise<string | undefined> {
  try {
    const result=await run("git",["--no-optional-locks","-C",path,...args],
      {encoding:"utf8",timeout:2_000,maxBuffer:256*1_024});
    return result.stdout.trim();
  } catch { return undefined; }
}
const clean = (text: string, limit: number) => text.replace(/[\u0000-\u001f\u007f]/g," ").trim().slice(0,limit);

async function read(binding: ProjectBindingSummary): Promise<ProjectRepositoryDetails> {
  const path=binding.localPathHint!;
  const root=await git(path,["rev-parse","--show-toplevel"]);
  const base={projectId:binding.projectId,repositoryId:binding.repositoryId,endpointId:binding.endpointId,
    commits:[],contributors:[],observedAt:Date.now()};
  if (!root) {
    const exists=await import("node:fs/promises").then(fs=>fs.stat(path).then(s=>s.isDirectory(),()=>false));
    return {...base,status:exists ? "not_git" : "unavailable"};
  }
  const [remote,revision,branch,status,history,shortlog,count]=await Promise.all([
    git(root,["remote","get-url","origin"]),git(root,["rev-parse","--verify","HEAD"]),
    git(root,["symbolic-ref","--quiet","--short","HEAD"]),
    git(root,["status","--porcelain=v1","--untracked-files=normal"]),
    git(root,["log","-8","--format=%H%x1f%an%x1f%ct%x1f%s%x1e","HEAD"]),
    git(root,["shortlog","-sn","HEAD"]),git(root,["rev-list","--count","HEAD"]),
  ]);
  const commits=(history ?? "").split("\u001e").flatMap(row=>{
    const [sha,author,time,subject]=row.trim().split("\u001f");
    return sha && /^[a-f0-9]{40,64}$/.test(sha) && Number.isFinite(Number(time)) && Number(time)>=0
      ? [{sha,author:clean(author ?? "",160),subject:clean(subject ?? "",240),committedAt:Number(time)*1_000}] : [];
  });
  const contributors=(shortlog ?? "").split("\n").flatMap(row=>{
    const match=row.match(/^\s*(\d+)\s+(.+)$/);
    return match ? [{name:clean(match[2]!,160),commits:Number(match[1])}] : [];
  });
  return ProjectRepositoryDetails.parse({...base,status:"ready",
    canonicalRepositoryId:canonicalRepositoryIdentity(remote,root),revision:revision || undefined,
    branch:branch || undefined,dirty:status == null ? undefined : status.length>0,
    commitCount:count == null ? (revision ? undefined : 0) : Number(count),commits,
    contributorCount:shortlog == null ? (revision ? undefined : 0) : contributors.length,
    contributors:contributors.slice(0,12)});
}

/** Bounded Git observations published under the existing Mesh encryption scope. */
export async function repositoryDetails(snapshot: MeshSnapshot, endpointId: string): Promise<ProjectRepositoryDetails[]> {
  const bindings=(snapshot.bindings ?? []).filter(binding=>binding.projectId===snapshot.projectId
    && binding.endpointId===endpointId && binding.available && binding.localPathHint);
  const reports:ProjectRepositoryDetails[]=[];
  const seen=new Set<string>();
  for (const binding of bindings.slice(0,64)) {
    if (seen.has(binding.repositoryId)) continue;
    seen.add(binding.repositoryId);
    reports.push(await read(binding));
  }
  return reports;
}
