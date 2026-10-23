import { realpathSync } from 'node:fs';
import type { MeshHandoffPrepare, SessionInfo } from '../../../../../../packages/protocol/schema';
import { inspectRepository } from '../../catalog';
import type { MeshStore } from '../../store';
import { matchesLocalCheckout } from '../graph/checkout-identity';

/** The controller chooses an already admitted binding, never an arbitrary path. */
export function resolveHandoffSource(store: MeshStore, session: SessionInfo,
  request: MeshHandoffPrepare, computer: string): SessionInfo {
  if (!request.sourceBindingId) return session;
  const binding = store.snapshot(request.projectId)?.bindings?.find(row =>
    row.bindingId === request.sourceBindingId && row.projectId === request.projectId
      && row.endpointId === computer && row.available);
  if (binding?.localPathHint) {
    const facts = inspectRepository(binding.localPathHint);
    try {
      if (facts.worktree && facts.revision && realpathSync(facts.root) === realpathSync(binding.localPathHint)
        && (facts.canonicalRepositoryId === binding.repositoryId || matchesLocalCheckout(binding.repositoryId, facts.root))) {
        return { ...session, worktree: facts.root, branch: facts.branch };
      }
    } catch { /* A removed checkout is not an admitted replacement. */ }
  }
  throw new Error('The selected repository is not available on this computer. Refresh the Project and choose its checkout again.');
}
