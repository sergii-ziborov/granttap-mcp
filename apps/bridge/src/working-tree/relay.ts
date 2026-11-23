/** The phone's working-tree requests, answered only to the phone that asked, under the chat's key. */
import { realpathSync } from "node:fs";
import type { RelayClient } from "../../../../packages/core/relay-client";
import { SessionChangesResult, SessionCommitResult, type SessionChangesQuery, type SessionCommit,
  type SessionInfo } from "../../../../packages/protocol/schema";
import { sendSessionPayload } from "../host/session-keys";
import { publishedSession } from "../session-catalog";
import { commitChosenPaths } from "./commit";
import { chatFolder, forgetFolder } from "./index";
import { readTree, readWorktrees } from "./status";

const MAX_LISTED = 200;
const MAX_WORKTREES = 100;

/**
 * The chat's checkout, or another checkout of its repository the phone named (`worktree`), read for
 * the phone, which waits: its Git reads go ahead of the background ones. Every checkout of the
 * repository is listed with it, the chat's own marked `current`. Another checkout is listed
 * read-only, without a `treeToken`, and only when it is one of the repository's worktrees.
 */
export async function listChanges(session: SessionInfo | undefined, query: SessionChangesQuery): Promise<SessionChangesResult> {
  const base = { type: "session.changes.result" as const, sessionId: query.sessionId, requestId: query.requestId, createdAt: Date.now() };
  const none = SessionChangesResult.parse({ ...base, files: [], total: 0, truncated: false, unavailable: true });
  const folder = session && chatFolder(session);
  const own = folder ? await readTree(folder, { urgent: true }) : undefined;
  if (!own) return none;
  const worktrees = await readWorktrees(own.root, { urgent: true }) ?? [];
  const named = query.worktree === undefined ? undefined : worktrees.find((tree) => samePath(tree.path, query.worktree!));
  if (query.worktree !== undefined && !named) return none;
  const tree = named && !samePath(named.path, own.root) ? await readTree(named.path, { urgent: true }) : own;
  if (!tree) return none;
  const listed = worktrees.slice(0, MAX_WORKTREES).map((checkout) => ({ path: checkout.path,
    ...(checkout.branch ? { branch: checkout.branch.slice(0, 256) } : {}), ...(checkout.detached ? { detached: true } : {}),
    ...(checkout.head ? { head: checkout.head } : {}), ...(samePath(checkout.path, own.root) ? { current: true } : {}),
    ...(checkout.locked ? { locked: true } : {}) }));
  return SessionChangesResult.parse({ ...base, ...(tree.branch ? { branch: tree.branch.slice(0, 256) } : {}),
    ...(tree.detached ? { detached: true } : {}), ...(tree.ahead !== undefined ? { ahead: tree.ahead } : {}),
    ...(tree.behind !== undefined ? { behind: tree.behind } : {}), ...(tree.operation ? { operation: tree.operation } : {}),
    folder: tree.root, ...(listed.length ? { worktrees: listed } : {}),
    files: tree.files.slice(0, MAX_LISTED), total: tree.files.length, truncated: tree.files.length > MAX_LISTED,
    ...(tree === own ? { treeToken: tree.token } : {}) });
}

/** Git prints a worktree's path as it stored it; macOS may reach the same folder through /private or a symlink. */
function samePath(left: string, right: string): boolean {
  if (left === right) return true;
  try { return realpathSync(left) === realpathSync(right); } catch { return false; }
}

export async function commitChanges(session: SessionInfo | undefined, request: SessionCommit): Promise<SessionCommitResult> {
  const base = { type: "session.commit.result" as const, sessionId: request.sessionId, requestId: request.requestId };
  const folder = session && chatFolder(session);
  const outcome = session && folder ? await commitChosenPaths(session, folder, request) : { ok: false, reason: "unavailable" as const };
  if (folder && outcome.ok) forgetFolder(folder);
  return SessionCommitResult.parse({ ...base, ...outcome, createdAt: Date.now() });
}

export async function handleWorkingTreeRequest(client: RelayClient, payload: SessionChangesQuery | SessionCommit,
  peerPublicKey?: string): Promise<boolean> {
  const session = publishedSession(client, payload.sessionId);
  const result = payload.type === "session.changes.query" ? await listChanges(session, payload) : await commitChanges(session, payload);
  await sendSessionPayload(client, result, payload.sessionId, "phone",
    { peerPublicKey, ttlMs: 5 * 60_000, reliable: payload.type === "session.commit" });
  return true;
}
