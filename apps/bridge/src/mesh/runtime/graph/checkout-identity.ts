import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ProjectBindingSummary } from "../../../../../../packages/protocol/schema";
import { inspectRepository, inspectRepositoryAsync, type RepositoryFacts } from "../../catalog";

/** One nonblocking native observation shared by admission, graph selection and Git details. */
export async function prepareGraphInspection(bindings: ProjectBindingSummary[], endpointId: string) {
  const paths = new Set(bindings.filter(binding => binding.endpointId === endpointId
    && binding.available && binding.localPathHint).flatMap(binding => {
      try { return [realpathSync(binding.localPathHint!)]; } catch { return []; }
    }));
  const observations = new Map(await Promise.all([...paths].map(async path => {
    try { return [path, await inspectRepositoryAsync(path)] as const; }
    catch { return [path, undefined] as const; }
  })));
  return (path: string): RepositoryFacts => {
    const facts = observations.get(realpathSync(path));
    if (!facts) throw new Error("The checkout was not observed for this publication");
    return { ...facts };
  };
}

/** Local identities name an exact directory, even after that directory gains an origin. */
export function matchesLocalCheckout(repositoryId: string, root: string): boolean {
  if (!repositoryId.startsWith("local:")) return false;
  const path = repositoryId.slice("local:".length);
  if (!isAbsolute(path)) return false;
  try { return realpathSync(path) === realpathSync(root); }
  catch { return false; }
}

/** Once admitted, one checkout contributes one graph to this Mesh. */
export function graphAnalysisBindings(bindings: ProjectBindingSummary[], endpointId?: string,
  inspect: (path: string) => RepositoryFacts = inspectRepository): ProjectBindingSummary[] {
  const selected = new Map<string, ProjectBindingSummary>();
  const observations = new Map<string, RepositoryFacts | undefined>();
  const nonRepositories = new Set<string>();
  const ranks = new Map<string, number>();
  for (const binding of bindings) {
    if (endpointId && binding.endpointId !== endpointId) continue;
    let path: string | undefined;
    if (binding.available && binding.localPathHint) {
      try { path = realpathSync(binding.localPathHint); } catch { /* Keep an unavailable checkout distinct. */ }
    }
    if (path && !observations.has(path)) {
      let facts: RepositoryFacts | undefined;
      try {
        const observed = inspect(path);
        if (observed.worktree && realpathSync(observed.root) === path) facts = observed;
        else nonRepositories.add(path);
      } catch { /* Unavailable roots retain their own identity. */ }
      observations.set(path, facts);
    }
    // A remembered commit from the parent does not make a subfolder a checkout.
    if (path && nonRepositories.has(path)) continue;
    const facts = path ? observations.get(path) : undefined;
    const canonical = facts?.canonicalRepositoryId === binding.repositoryId;
    const scoped = facts && matchesLocalCheckout(binding.repositoryId, facts.root);
    const rank = canonical ? 3 : scoped ? 2 : binding.repositoryId.startsWith("local:") ? 0 : 1;
    const candidate = (canonical || scoped) && facts?.revision
      ? { ...binding, revision: facts.revision } : binding;
    const key = JSON.stringify([binding.endpointId, path ?? binding.repositoryId]);
    const previous = selected.get(key);
    if (!previous || rank > (ranks.get(key) ?? 0)) {
      selected.set(key, candidate);
      ranks.set(key, rank);
    }
  }
  return [...selected.values()];
}
