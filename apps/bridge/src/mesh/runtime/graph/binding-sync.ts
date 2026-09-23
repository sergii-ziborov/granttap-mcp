import { resolve } from "node:path";
import type { MeshSnapshot } from "../../../../../../packages/protocol/schema";
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
): Promise<void> {
  const localEndpoint = dependencies.endpoint();
  const candidates = (snapshot.bindings ?? []).filter((binding) =>
    binding.endpointId === localEndpoint && binding.available && binding.localPathHint);
  await Promise.all(candidates.map(async (binding) => {
    try {
      const path = binding.localPathHint!;
      const facts = dependencies.inspect(path);
      if (!facts.worktree || resolve(facts.root) !== resolve(path)
        || facts.canonicalRepositoryId !== binding.repositoryId) return;
      await dependencies.sync(snapshot.project, {
        summary: binding,
        localRoot: facts.root,
        canonicalRemote: facts.baseRemote,
        lastSeenAt: Date.now(),
      });
    } catch { /* A stale checkout cannot prevent other verified bindings from recovery. */ }
  }));
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
