import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RelayClient } from "../../../../packages/core/relay-client";
import { SessionsStatus, type SessionInfo } from "../../../../packages/protocol/schema";
import { configDir, writePrivateFile } from "../config";
import { nativeTranscriptRoots, nativeTranscriptSource, restoreNativeTranscriptSource } from "../sessions";
export { recoverCatalogBindings } from "./startup-recovery";

const catalogs = new WeakMap<RelayClient, SessionsStatus | undefined>();
const cachePath = () => join(configDir(), "session-catalog-cache.json");
const scope = (client: RelayClient) => createHash("sha256")
  .update([client.room, ...Object.values(nativeTranscriptRoots())].join("\0")).digest("hex");

function metadata(session: SessionInfo): SessionInfo {
  const { sessionId, agent, state, startedAt, lastActivityAt, tokensSession, tokensLastTurn,
    cwd, model, projectId, taskId, computerId } = session;
  return { sessionId, agent, state, startedAt, lastActivityAt, tokensSession, tokensLastTurn,
    cwd, model, projectId, taskId, computerId };
}

/** Keep native identity, not capability descriptors or message contents. */
export function rememberPublishedCatalog(client: RelayClient, status: SessionsStatus): void {
  const previous = catalogs.get(client);
  const history = status.history ?? previous?.history;
  const compact: SessionsStatus = { type: "sessions.status", machine: status.machine,
    sessions: status.sessions.map(metadata), history: history?.map(metadata),
    generatedAt: status.generatedAt };
  catalogs.set(client, { ...status, history });
  const paths = Object.fromEntries([...compact.sessions, ...(compact.history ?? [])]
    .flatMap(session => { const path = nativeTranscriptSource(session);
      return path ? [[session.sessionId, path]] : []; }));
  try { writePrivateFile(cachePath(), JSON.stringify({ scope: scope(client), status: compact, paths })); }
  catch { /* The current in-memory catalog remains readable on a full disk. */ }
}

export function publishedCatalog(client: RelayClient): SessionsStatus | undefined {
  if (catalogs.has(client)) return catalogs.get(client);
  let catalog: SessionsStatus | undefined;
  try {
    if (statSync(cachePath()).size > 1024 * 1024) throw new Error("catalog cache exceeds limit");
    const record = JSON.parse(readFileSync(cachePath(), "utf8"));
    const parsed = SessionsStatus.safeParse(record.status);
    if (record.scope === scope(client) && parsed.success) {
      catalog = parsed.data;
      for (const session of [...catalog.sessions, ...(catalog.history ?? [])]) {
        const path = record.paths?.[session.sessionId];
        if (typeof path === "string") restoreNativeTranscriptSource(session, path);
      }
    }
  } catch { /* Missing, malformed, or foreign catalogs fall back to discovery. */ }
  catalogs.set(client, catalog);
  return catalog;
}

export function publishedSession(client: RelayClient, sessionId: string): SessionInfo | undefined {
  const status = publishedCatalog(client);
  return status?.sessions.find(session => session.sessionId === sessionId)
    ?? status?.history?.find(session => session.sessionId === sessionId);
}

/** Send saved Now heads under their task keys before an expensive fresh scan. */
export async function resumePublishedChats(client: RelayClient,
  publish: (session: SessionInfo, status: SessionsStatus) => Promise<unknown>): Promise<void> {
  const status = publishedCatalog(client);
  if (!status) return;
  for (const session of status.sessions) {
    if (session.agent !== "codex" && session.agent !== "claude") continue;
    try { await publish(session, status); } catch { /* Retry on the regular tick. */ }
  }
}
