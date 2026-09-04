import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import type { SessionInfo } from "../../../../packages/protocol/schema";
import { inspectRepository } from "./catalog";
import { OBSERVED_WRITE_TTL_MS, recentObservedWrites } from "./observed-writes";
import type { MeshStore } from "./store";

/**
 * Turn what agents were seen writing into intent claims on their Tasks.
 *
 * A claim an agent announces is rare; a file it edits is not. The claim here
 * is derived from the edit and marked as such, so an overlap is visible while
 * the work is still happening rather than at the merge. Only chats the Mesh
 * has linked to a Task contribute, and every path is made repository-relative
 * first, because that is what claims and the phone compare.
 */
export function deriveObservedClaims(
  store: MeshStore,
  sessions: readonly SessionInfo[],
  now: number = Date.now(),
  inspect: (cwd: string) => { root: string } = inspectRepository,
): number {
  let recorded = 0;
  for (const session of sessions) {
    const { projectId, taskId, cwd } = session;
    if (!projectId || !taskId || !cwd) continue;
    const writes = recentObservedWrites(session.sessionId, now);
    if (writes.length === 0) continue;
    const root = inspect(cwd).root;
    for (const write of writes) {
      const resource = repositoryRelative(write.path, root);
      if (!resource) continue;
      const accepted = store.observeClaim({
        claimId: `observed-${taskId}-${createHash("sha256").update(resource).digest("hex").slice(0, 16)}`,
        projectId, taskId, ownerSessionId: session.sessionId, resource,
        mode: "intent", createdAt: write.at, expiresAt: write.at + OBSERVED_WRITE_TTL_MS,
      });
      if (accepted) recorded += 1;
    }
  }
  return recorded;
}

/** A path inside the repository, as the claim vocabulary spells it. */
export function repositoryRelative(path: string, root: string): string | undefined {
  const value = isAbsolute(path) ? relative(root, path) : path;
  if (!value || value.startsWith("..") || value.includes("\0")) return undefined;
  const normalized = value.split(sep).join("/").replace(/^\.\//, "");
  return normalized.length > 0 && normalized.length <= 512 ? normalized : undefined;
}
