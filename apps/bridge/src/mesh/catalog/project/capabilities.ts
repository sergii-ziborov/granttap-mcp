import type {
  MeshProvider,
  ProjectMcpServer,
  SessionInfo,
} from "../../../../../../packages/protocol/schema";

const PROVIDERS = new Set(["claude", "codex", "cursor", "grok"]);

type MutableServer = Omit<ProjectMcpServer, "sessionIds"> & { sessionIds: Set<string> };

/** Project-scoped MCP inventory with the exact executions each control affects. */
export function projectMcpServers(
  sessions: SessionInfo[],
  projectId: string,
  executionIds: Set<string>,
): ProjectMcpServer[] {
  const catalog = new Map<string, MutableServer>();
  for (const session of sessions) {
    if (session.projectId !== projectId && !executionIds.has(session.sessionId)) continue;
    if (!PROVIDERS.has(session.agent) || !session.computerId) continue;
    for (const server of session.mcpServers ?? []) {
      const provider = session.agent as MeshProvider;
      const key = JSON.stringify([
        session.computerId, provider, server.name,
        server.version ?? null, server.authStatus ?? null,
      ]);
      const current = catalog.get(key);
      if (current) {
        current.sessionIds.add(session.sessionId);
        current.configuredEnabled &&= server.configuredEnabled;
        current.allowed &&= server.allowed;
        current.title ??= server.title;
      } else {
        catalog.set(key, {
          name: server.name,
          title: server.title,
          provider,
          endpointId: session.computerId,
          configuredEnabled: server.configuredEnabled,
          allowed: server.allowed,
          authStatus: server.authStatus,
          version: server.version,
          metadataSource: server.metadataSource,
          sessionIds: new Set([session.sessionId]),
        });
      }
    }
  }
  return [...catalog.values()].map((server) => ({
    ...server,
    sessionIds: [...server.sessionIds].sort().slice(0, 64),
  })).sort((left, right) =>
    `${left.endpointId}\0${left.provider}\0${left.name}\0${left.version ?? ""}`
      .localeCompare(`${right.endpointId}\0${right.provider}\0${right.name}\0${right.version ?? ""}`));
}
