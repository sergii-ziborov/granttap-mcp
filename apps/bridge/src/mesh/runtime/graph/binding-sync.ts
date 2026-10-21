import { realpathSync } from "node:fs";
import type { MeshSnapshot, ProjectRepositoryGraph } from "../../../../../../packages/protocol/schema";
import { queueProjectBindingSync } from "../../../engine/runtime/engine-projects";
import { inspectRepository } from "../../catalog";
import { computerId } from "../../identity/computer";
import { matchesLocalCheckout } from "./checkout-identity";

/**
 * Re-admit this computer's verified checkouts before an explicit Graph build.
 *
 * Only a repository whose Graph is genuinely unavailable is reported. A plain
 * folder an agent ran in, a subfolder of a repository, a removed checkout and
 * a former identity of a checkout another binding already describes are not
 * repositories with a broken Graph; reporting them filled Mesh Health with
 * errors nobody could act on.
 */
export async function refreshLocalGraphBindings(
  snapshot: MeshSnapshot,
  dependencies: {
    endpoint: () => string;
    inspect: typeof inspectRepository;
    sync: typeof queueProjectBindingSync;
  } = { endpoint: computerId, inspect: inspectRepository, sync: queueProjectBindingSync },
): Promise<ProjectRepositoryGraph[]> {
  const localEndpoint = dependencies.endpoint();
  const candidates = (snapshot.bindings ?? []).filter((binding) =>
    binding.endpointId === localEndpoint && binding.available && binding.localPathHint);
  const failures: ProjectRepositoryGraph[] = [];
  const checkouts = candidates.flatMap((binding) => {
    const facts = readCheckout(dependencies.inspect, binding.localPathHint!);
    return facts ? [{ binding, facts, real: realpathSync(facts.root) }] : [];
  });
  await Promise.all(checkouts.map(async ({ binding, facts, real }) => {
    const pathIdentity = matchesLocalCheckout(binding.repositoryId, facts.root);
    if (facts.canonicalRepositoryId !== binding.repositoryId && !pathIdentity) {
      const described = checkouts.some((other) => other.real === real
        && (other.binding.repositoryId === facts.canonicalRepositoryId
          || matchesLocalCheckout(other.binding.repositoryId, facts.root)));
      if (!described) failures.push({ projectId: snapshot.projectId, repositoryId: binding.repositoryId,
        revision: "unverified", weavatrixVersion: "unknown", analysisStatus: "UNAVAILABLE",
        analysisErrorCode: "REPOSITORY_IDENTITY_MISMATCH",
        nodes: [], relations: [], totalNodes: 0, totalRelations: 0, truncated: false });
      return;
    }
    try {
      const admitted = await dependencies.sync(snapshot.project, {
        summary: { ...binding, revision: facts.revision ?? binding.revision },
        localRoot: facts.root,
        // A local binding is scoped by its verified path. Do not relabel it as
        // a remote repository or move it into that repository's Project scope.
        canonicalRemote: pathIdentity ? undefined : facts.baseRemote,
        lastSeenAt: Date.now(),
      });
      if (!admitted) failures.push(admissionFailure(snapshot, binding));
    } catch { failures.push(admissionFailure(snapshot, binding)); }
  }));
  return failures;
}

/** A Git checkout rooted exactly at the bound path, or nothing a Graph can be built from. */
function readCheckout(inspect: typeof inspectRepository, path: string) {
  try {
    const facts = inspect(path);
    if (!facts.worktree || realpathSync(facts.root) !== realpathSync(path)) return undefined;
    return facts;
  } catch {
    return undefined;
  }
}

function admissionFailure(snapshot: MeshSnapshot, binding: NonNullable<MeshSnapshot["bindings"]>[number]): ProjectRepositoryGraph {
  return { projectId: snapshot.projectId, repositoryId: binding.repositoryId,
    revision: "unverified", weavatrixVersion: "unknown", analysisStatus: "UNAVAILABLE",
    analysisErrorCode: "ENGINE_ADMISSION_UNAVAILABLE", nodes: [], relations: [],
    totalNodes: 0, totalRelations: 0, truncated: false };
}

/** Rehydrate previously admitted Git checkouts after Engine restart. */
export async function recoverLocalGraphBindings(
  snapshots: MeshSnapshot[],
  dependencies?: Parameters<typeof refreshLocalGraphBindings>[1],
): Promise<void> {
  for (const snapshot of snapshots) {
    await refreshLocalGraphBindings(snapshot, dependencies);
  }
}
