/**
 * The uncommitted state of each live chat's working folder, on its session record (`workingTree`), and
 * the phone's two requests about it (`relay.ts`): list the changes, commit chosen paths.
 *
 * A folder is read at most every five seconds, only for the live catalog's chats, one reading per
 * folder however many chats share it, through the bounded Git pool. A catalog uses the newest reading
 * it has and asks for a fresh one in the background; the next catalog carries it.
 */
import type { SessionInfo, SessionWorkingTree } from "../../../../packages/protocol/schema";
import { readTree, type TreeReading } from "./status";

export const READ_EVERY_MS = 5_000;
const MAX_FOLDERS = 64;
type Cached = { at: number; reading?: TreeReading; pending?: Promise<TreeReading | undefined> };
const cache = new Map<string, Cached>();

export function chatFolder(session: Pick<SessionInfo, "worktree" | "cwd">): string | undefined {
  return session.worktree ?? session.cwd;
}

/** A fresh reading, shared with any read already running for the folder. */
export function readFolder(folder: string, now = Date.now()): Promise<TreeReading | undefined> {
  const known = cache.get(folder);
  if (known?.pending) return known.pending;
  const pending = readTree(folder).then((reading) => {
    cache.set(folder, { at: Date.now(), reading });
    while (cache.size > MAX_FOLDERS) cache.delete(cache.keys().next().value!);
    return reading;
  }, () => { cache.set(folder, { at: Date.now() }); return undefined; });
  cache.set(folder, { at: known?.at ?? now, reading: known?.reading, pending });
  return pending;
}

/** After a commit the next catalog must not show the old count. */
export function forgetFolder(folder: string): void {
  cache.delete(folder);
}

function summary(reading: TreeReading, at: number): SessionWorkingTree {
  return { ...(reading.branch ? { branch: reading.branch.slice(0, 256) } : {}), ...(reading.detached ? { detached: true } : {}),
    ...(reading.ahead !== undefined ? { ahead: reading.ahead, behind: reading.behind ?? 0 } : {}),
    changed: reading.files.length, ...(reading.operation ? { operation: reading.operation } : {}), observedAt: Math.max(1, Math.round(at)) };
}

/** Each chat with its folder's newest reading; stale or unknown folders are read again in the background. */
export function attachWorkingTrees(sessions: SessionInfo[], now = Date.now()): SessionInfo[] {
  const folders = new Set<string>();
  const out = sessions.map((session) => {
    const folder = chatFolder(session);
    if (!folder) return session;
    folders.add(folder);
    const known = cache.get(folder);
    return known?.reading ? { ...session, workingTree: summary(known.reading, known.at) } : session;
  });
  for (const folder of [...folders].slice(0, MAX_FOLDERS)) {
    const known = cache.get(folder);
    if (!known || (!known.pending && now - known.at >= READ_EVERY_MS)) void readFolder(folder, now).catch(() => undefined);
  }
  return out;
}

/** For tests. */
export function forgetWorkingTrees(): void {
  cache.clear();
}
