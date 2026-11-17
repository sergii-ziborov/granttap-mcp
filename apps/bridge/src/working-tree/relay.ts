/** The phone's working-tree requests, answered only to the phone that asked, under the chat's key. */
import type { RelayClient } from "../../../../packages/core/relay-client";
import { SessionChangesResult, SessionCommitResult, type SessionChangesQuery, type SessionCommit,
  type SessionInfo } from "../../../../packages/protocol/schema";
import { sendSessionPayload } from "../host/session-keys";
import { publishedSession } from "../session-catalog";
import { commitChosenPaths } from "./commit";
import { chatFolder, forgetFolder } from "./index";
import { readTree } from "./status";

const MAX_LISTED = 200;

export async function listChanges(session: SessionInfo | undefined, query: SessionChangesQuery): Promise<SessionChangesResult> {
  const base = { type: "session.changes.result" as const, sessionId: query.sessionId, requestId: query.requestId, createdAt: Date.now() };
  const folder = session && chatFolder(session);
  const tree = folder ? await readTree(folder) : undefined;
  if (!tree) return SessionChangesResult.parse({ ...base, files: [], total: 0, truncated: false, unavailable: true });
  return SessionChangesResult.parse({ ...base, ...(tree.branch ? { branch: tree.branch.slice(0, 256) } : {}),
    ...(tree.detached ? { detached: true } : {}), ...(tree.operation ? { operation: tree.operation } : {}),
    files: tree.files.slice(0, MAX_LISTED), total: tree.files.length, truncated: tree.files.length > MAX_LISTED,
    treeToken: tree.token });
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
