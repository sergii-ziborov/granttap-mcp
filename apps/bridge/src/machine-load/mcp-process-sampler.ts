import type { AgentProcessLoad, ProcessRow } from "./process-sampler";

/** A configured stdio MCP server, as the agent would launch it. */
export type McpServerCommand = {
  name: string;
  command: string;
  args?: readonly string[];
};

/**
 * Attribute running processes to the MCP servers that own them.
 *
 * Tool calls are read back from agent transcripts after they finished, so a
 * call's own cost can never be measured directly. What can be observed is the
 * server process still sitting there between calls, which is what answers "how
 * much is this MCP costing me" — reported as attributed rather than measured,
 * because that is what it is.
 */
export function attributeMcpProcesses(
  rows: readonly ProcessRow[],
  servers: readonly McpServerCommand[],
): Record<string, AgentProcessLoad> {
  const byServer: Record<string, AgentProcessLoad> = {};
  for (const row of rows) {
    const server = serverForCommand(row.command, servers);
    if (!server) continue;
    const current = byServer[server] ?? { processes: 0, cpuPercent: 0, memoryBytes: 0 };
    byServer[server] = {
      processes: current.processes + 1,
      cpuPercent: Math.round((current.cpuPercent + row.cpuPercent) * 100) / 100,
      memoryBytes: current.memoryBytes + row.rssBytes,
    };
  }
  return byServer;
}

/**
 * A server owns a process when the launch command appears in it.
 *
 * The command alone is far too weak on its own — every stdio server in the
 * world runs under `node` — so a server that carries arguments must match one
 * of them too, and the longest argument is used because it is the one that
 * names the server rather than a flag shared with everything else.
 */
function serverForCommand(
  command: string,
  servers: readonly McpServerCommand[],
): string | undefined {
  const haystack = command.trim();
  if (!haystack) return undefined;
  let best: { name: string; length: number } | undefined;
  for (const server of servers) {
    const leaf = server.command.split("/").pop();
    if (!leaf || !haystack.includes(leaf)) continue;
    const distinguishing = [...(server.args ?? [])]
      .filter((arg) => arg.length > 1 && !arg.startsWith("-"))
      .sort((left, right) => right.length - left.length)[0];
    if (distinguishing) {
      if (!haystack.includes(distinguishing)) continue;
      if (!best || distinguishing.length > best.length) {
        best = { name: server.name, length: distinguishing.length };
      }
      continue;
    }
    // A bare command with no arguments only wins when nothing more specific did.
    best ??= { name: server.name, length: 0 };
  }
  return best?.name;
}
