import { realpathSync } from 'node:fs';
import type { MeshHandoffPrepare, MeshSnapshot, ProjectBindingSummary, SessionInfo } from '../../../../../../packages/protocol/schema';
import { inspectRepository } from '../../catalog';
import type { MeshStore } from '../../store';
import { matchesLocalCheckout } from '../graph/checkout-identity';

/** Resolve the Task's admitted checkout; an explicit choice can replace that default. */
export function resolveHandoffSource(store: MeshStore, session: SessionInfo,
  request: MeshHandoffPrepare, computer: string): SessionInfo {
  const snapshot = store.snapshot(request.projectId);
  if (!request.sourceBindingId) {
    const cwd = session.worktree ?? session.cwd;
    if (cwd) {
      const native = inspectRepository(cwd);
      if (native.worktree && native.revision) {
        return { ...session, worktree: native.root, branch: session.branch ?? native.branch };
      }
    }
  }
  const binding = request.sourceBindingId
    ? snapshot?.bindings?.find(row => row.bindingId === request.sourceBindingId
      && row.projectId === request.projectId && row.endpointId === computer && row.available)
    : inferBinding(snapshot, session, request, computer);
  if (!binding && !request.sourceBindingId) return session;
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

function samePath(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  try { return realpathSync(left) === realpathSync(right); } catch { return false; }
}

function inferBinding(snapshot: MeshSnapshot | undefined, session: SessionInfo,
  request: MeshHandoffPrepare, computer: string): ProjectBindingSummary | undefined {
  const paths = new Set<string>();
  const bindings = (snapshot?.bindings ?? []).filter(row => {
    if (row.projectId !== request.projectId || row.endpointId !== computer
      || !row.available || !row.revision || !row.localPathHint) return false;
    try {
      const path = realpathSync(row.localPathHint);
      if (paths.has(path)) return false;
      paths.add(path);
      return true;
    } catch { return false; }
  });
  if (!bindings.length) return undefined;
  const execution = snapshot?.executions.find(row => row.taskId === request.taskId
    && row.provider === session.agent && row.sessionId === session.sessionId
    && row.computerId === computer && row.endedAt == null);
  if (execution?.worktree) {
    const exact = bindings.find(row => samePath(row.localPathHint, execution.worktree));
    if (exact) return exact;
    throw new Error('This Task\'s source checkout is unavailable. Refresh its computer before transferring.');
  }
  const byExecution = execution?.repositoryId
    ? bindings.filter(row => row.repositoryId === execution.repositoryId) : [];
  if (byExecution.length === 1) return byExecution[0];
  const parent = snapshot?.bindings?.some(row => row.repositoryId === execution?.repositoryId
    && row.endpointId === computer && !row.revision && samePath(row.localPathHint, session.cwd));
  if (execution?.repositoryId && !parent) {
    throw new Error('This Task\'s source repository is unavailable. Refresh its computer before transferring.');
  }
  const claims = snapshot?.claims.filter(row => row.taskId === request.taskId
    && row.ownerSessionId === session.sessionId && row.expiresAt > Date.now()
    && (!row.endpointId || row.endpointId === computer)) ?? [];
  const byClaim = bindings.filter(row => claims.some(claim =>
    claim.repositoryId === row.repositoryId && (!claim.worktree || samePath(claim.worktree, row.localPathHint))));
  if (byClaim.length === 1) return byClaim[0];
  const byProject = bindings.filter(row => row.repositoryId === snapshot?.project.canonicalRepositoryId);
  if (byProject.length === 1) return byProject[0];
  if (bindings.length === 1) return bindings[0];
  throw new Error('Multiple Project checkouts are available. Choose the repository this Task should continue in.');
}
