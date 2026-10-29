import { ProjectRepositoryDetails, type MeshSnapshot, type ProjectBindingSummary } from "../../../../../packages/protocol/schema";
import { inspectRepositoryAsync, type RepositoryFacts } from "../catalog";
import { git } from "./git";
import { repositoryHistory } from "./history";

type ObservationOptions = { background?: boolean; inspect?: (path: string) => RepositoryFacts };

async function observed(path: string, options: ObservationOptions): Promise<RepositoryFacts> {
  try { if (options.inspect) return options.inspect(path); }
  catch { /* Removed paths still need an explicit unavailable report. */ }
  return inspectRepositoryAsync(path);
}

async function read(binding: ProjectBindingSummary, options: ObservationOptions): Promise<ProjectRepositoryDetails> {
  const path=binding.localPathHint!;
  const facts = await observed(path, options);
  const root = facts.worktree;
  const base={projectId:binding.projectId,repositoryId:binding.repositoryId,endpointId:binding.endpointId,
    commits:[],contributors:[],observedAt:Date.now()};
  if (!root) {
    const exists=await import("node:fs/promises").then(fs=>fs.stat(path).then(s=>s.isDirectory(),()=>false));
    return {...base,status:exists ? "not_git" : "unavailable"};
  }
  const [status, history] = await Promise.all([
    git(root,["status","--porcelain=v1","--untracked-files=normal"]),
    repositoryHistory(root, facts.revision, options.background === true),
  ]);
  return ProjectRepositoryDetails.parse({...base, ...history, status:"ready",
    canonicalRepositoryId: facts.canonicalRepositoryId, revision: facts.revision,
    branch: facts.branch, dirty:status == null ? undefined : status.length>0 });
}

/** Bounded Git observations published under the existing Mesh encryption scope. */
export async function repositoryDetails(snapshot: MeshSnapshot, endpointId: string,
  options: ObservationOptions = {}): Promise<ProjectRepositoryDetails[]> {
  const bindings=(snapshot.bindings ?? []).filter(binding=>binding.projectId===snapshot.projectId
    && binding.endpointId===endpointId && binding.available && binding.localPathHint);
  const reports:ProjectRepositoryDetails[]=[];
  const seen=new Set<string>();
  for (const binding of bindings.slice(0,64)) {
    if (seen.has(binding.repositoryId)) continue;
    seen.add(binding.repositoryId);
    reports.push(await read(binding, options));
  }
  return reports;
}
