import type { TaskCapsule } from '../../../../../../packages/protocol/schema';
import { dirtyDiffHash } from '../../admin/capsule';
import { inspectRepository, workingTreeState } from '../../catalog';

/**
 * Whether the source checkout is still what its capsule described.
 *
 * A prepared transfer to another computer is confirmed later. Uncommitted work
 * may be left behind — the person was warned — but it has to be the same work
 * they agreed to leave, on the same commit. A checkpoint commit already holds
 * that work, so the source only has to keep its commit.
 */
export function sourceCheckoutUnchanged(cwd: string | undefined, capsule: TaskCapsule): boolean {
  if (!cwd) return false;
  try {
    if (inspectRepository(cwd).revision !== capsule.baseSha) return false;
    if (capsule.checkpoint) return true;
    const tree = workingTreeState(cwd);
    if (tree !== (capsule.workingTree ?? 'unknown')) return false;
    return tree !== 'dirty' || dirtyDiffHash(cwd) === capsule.dirtyDiffHash;
  } catch {
    return false;
  }
}
