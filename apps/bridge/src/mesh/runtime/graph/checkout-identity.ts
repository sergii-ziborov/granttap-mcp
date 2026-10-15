import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ProjectBindingSummary } from "../../../../../../packages/protocol/schema";

/** Local identities name an exact directory, even after that directory gains an origin. */
export function matchesLocalCheckout(repositoryId: string, root: string): boolean {
  if (!repositoryId.startsWith("local:")) return false;
  const path = repositoryId.slice("local:".length);
  if (!isAbsolute(path)) return false;
  try { return realpathSync(path) === realpathSync(root); }
  catch { return false; }
}

/** Once admitted, one checkout contributes one graph to this Mesh. */
export function graphAnalysisBindings(bindings: ProjectBindingSummary[]): ProjectBindingSummary[] {
  const selected = new Map<string, ProjectBindingSummary>();
  for (const binding of bindings) {
    let path: string | undefined;
    if (binding.available && binding.localPathHint) {
      try { path = realpathSync(binding.localPathHint); } catch { /* Keep an unavailable checkout distinct. */ }
    }
    const key = JSON.stringify([binding.endpointId, path ?? binding.repositoryId]);
    const previous = selected.get(key);
    if (!previous || (previous.repositoryId.startsWith("local:") && !binding.repositoryId.startsWith("local:"))) {
      selected.set(key, binding);
    }
  }
  return [...selected.values()];
}
