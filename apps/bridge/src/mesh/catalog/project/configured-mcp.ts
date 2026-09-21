import type { ProjectMcpServer } from "../../../../../../packages/protocol/schema";
import { mcpServersForProvider } from "../../../capabilities";

const PROVIDERS = ["claude", "codex", "cursor"] as const;

/** Native configuration visible from this endpoint's admitted workspaces. */
export function configuredProjectMcpServers(
  endpointId: string, workspaces: string[], providers: readonly (typeof PROVIDERS)[number][] = PROVIDERS,
): ProjectMcpServer[] {
  const rows = new Map<string, ProjectMcpServer>();
  for (const cwd of [...new Set(workspaces)].sort()) {
    for (const provider of providers) {
      for (const server of mcpServersForProvider(provider, cwd)) {
        const key = JSON.stringify([endpointId, provider, server.name]);
        const value: ProjectMcpServer = {
          name: server.name, title: server.title, provider, endpointId,
          configuredEnabled: server.configuredEnabled, allowed: server.allowed,
          authStatus: server.authStatus, version: server.version,
          metadataSource: server.metadataSource, sessionIds: [],
        };
        const prior = rows.get(key);
        if (prior && (prior.version !== value.version
          || prior.authStatus !== value.authStatus
          || prior.configuredEnabled !== value.configuredEnabled)) {
          // Two admitted workspaces disagree. Avoid claiming either version
          // as the Project's selected implementation.
          rows.set(key, { ...value, version: undefined, authStatus: "conflict" });
        } else if (!prior) rows.set(key, value);
      }
    }
  }
  return [...rows.values()].sort((a, b) =>
    `${a.endpointId}\0${a.provider}\0${a.name}`
      .localeCompare(`${b.endpointId}\0${b.provider}\0${b.name}`));
}

/** Execution reports add exact native sessions to the same configuration row. */
export function mergeConfiguredMcpServers(
  configured: ProjectMcpServer[], executions: ProjectMcpServer[],
): ProjectMcpServer[] {
  const rows = new Map(configured.map((row) => [
    JSON.stringify([row.endpointId, row.provider, row.name]), row,
  ]));
  for (const execution of executions) {
    const key = JSON.stringify([execution.endpointId, execution.provider, execution.name]);
    const configuredRow = rows.get(key);
    if (!configuredRow) { rows.set(key, execution); continue; }
    if (configuredRow.authStatus === "conflict") {
      rows.set(key, { ...configuredRow,
        sessionIds: [...new Set([...configuredRow.sessionIds, ...execution.sessionIds])],
      });
      continue;
    }
    if (configuredRow.sessionIds.length > 0 && configuredRow.authStatus !== execution.authStatus
      || configuredRow.version && execution.version
      && configuredRow.version !== execution.version) {
      rows.set(key, { ...configuredRow, version: undefined, authStatus: "conflict",
        sessionIds: execution.sessionIds });
      continue;
    }
    rows.set(key, {
      ...configuredRow, ...execution,
      version: execution.version ?? configuredRow.version,
      authStatus: execution.authStatus ?? configuredRow.authStatus,
    });
  }
  return [...rows.values()].sort((a, b) =>
    `${a.endpointId}\0${a.provider}\0${a.name}`
      .localeCompare(`${b.endpointId}\0${b.provider}\0${b.name}`));
}
