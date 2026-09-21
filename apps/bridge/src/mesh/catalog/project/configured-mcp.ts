import type { ProjectMcpServer } from "../../../../../../packages/protocol/schema";
import { mcpServersForProvider } from "../../../capabilities";
import { descriptorsForProvider } from "../../../capabilities/descriptors";

const PROVIDERS = ["claude", "codex", "cursor"] as const;

/** Native configuration visible from this endpoint's admitted workspaces. */
export function configuredProjectMcpServers(
  endpointId: string, workspaces: string[], providers: readonly (typeof PROVIDERS)[number][] = PROVIDERS,
): ProjectMcpServer[] {
  const rows = new Map<string, ProjectMcpServer>();
  const implementations = new Map<string, string>();
  for (const cwd of [...new Set(workspaces)].sort()) {
    for (const provider of providers) {
      const descriptors = new Map(descriptorsForProvider(provider, cwd)
        .map((descriptor) => [descriptor.name, descriptor]));
      for (const server of mcpServersForProvider(provider, cwd)) {
        const key = JSON.stringify([endpointId, provider, server.name]);
        const implementation = JSON.stringify(canonical(descriptors.get(server.name)?.transport ?? null));
        const value: ProjectMcpServer = {
          name: server.name, title: server.title, provider, endpointId,
          configuredEnabled: server.configuredEnabled, allowed: server.allowed,
          authStatus: server.authStatus, version: server.version,
          metadataSource: server.metadataSource, sessionIds: [],
        };
        const prior = rows.get(key);
        if (prior && (prior.version !== value.version
          || prior.authStatus !== value.authStatus
          || prior.configuredEnabled !== value.configuredEnabled
          || implementations.get(key) !== implementation)) {
          // Two admitted workspaces disagree. Avoid claiming either version
          // as the Project's selected implementation.
          rows.set(key, { ...value, version: undefined, authStatus: "conflict" });
        } else if (!prior) rows.set(key, value);
        if (!prior) implementations.set(key, implementation);
      }
    }
  }
  return [...rows.values()].sort((a, b) =>
    `${a.endpointId}\0${a.provider}\0${a.name}`
      .localeCompare(`${b.endpointId}\0${b.provider}\0${b.name}`));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
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
