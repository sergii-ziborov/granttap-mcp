import { realpathSync } from "node:fs";
import type { MeshSnapshot, ProjectRepositoryGraph } from "../../../../../../packages/protocol/schema";
import { queueProjectBindingSync } from "../../../engine/runtime/engine-projects";
import { inspectRepository } from "../../catalog";
import { computerId } from "../../identity/computer";

/** Re-admit this computer's verified checkouts before an explicit Graph build. */
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
  await Promise.all(candidates.map(async (binding) => {
    try {
      const path = binding.localPathHint!;
      const facts = dependencies.inspect(path);
      if (!facts.worktree || realpathSync(facts.root) !== realpathSync(path)
        || facts.canonicalRepositoryId !== binding.repositoryId) {
        failures.push({ projectId: snapshot.projectId, repositoryId: binding.repositoryId,
          revision: "unverified", weavatrixVersion: "unknown", analysisStatus: "UNAVAILABLE",
          analysisErrorCode: facts.worktree ? "REPOSITORY_IDENTITY_MISMATCH" : "REPOSITORY_IDENTITY_UNVERIFIED",
          nodes: [], relations: [], totalNodes: 0, totalRelations: 0, truncated: false });
        return;
      }
      const admitted = await dependencies.sync(snapshot.project, {
        summary: binding,
        localRoot: facts.root,
        canonicalRemote: facts.baseRemote,
        lastSeenAt: Date.now(),
      });
      if (!admitted) failures.push(admissionFailure(snapshot, binding));
    } catch { failures.push(admissionFailure(snapshot, binding)); }
  }));
  return failures;
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
