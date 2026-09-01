import type { SessionInfo } from "../../../../packages/protocol/schema";
import { descriptorsForSession } from "../capabilities/descriptors";
import { attributeMcpProcesses, type McpServerCommand } from "./mcp-process-sampler";
import { recordMcpLoad } from "./mcp-load-cache";
import { sampleProcessRows } from "./process-sampler";

/** Every stdio server the visible sessions could have launched, deduplicated. */
export function configuredMcpCommands(sessions: readonly SessionInfo[]): McpServerCommand[] {
  const byName = new Map<string, McpServerCommand>();
  for (const session of sessions) {
    for (const descriptor of descriptorsForSession(session)) {
      const command = descriptor.transport?.command;
      if (typeof command !== "string" || !command || byName.has(descriptor.name)) continue;
      const args = Array.isArray(descriptor.transport?.args)
        ? descriptor.transport.args.filter((arg): arg is string => typeof arg === "string")
        : undefined;
      byName.set(descriptor.name, { name: descriptor.name, command, args });
    }
  }
  return [...byName.values()];
}

/**
 * Sample what each MCP server is costing right now.
 *
 * Discovery reads agent config from disk, so a failure here must never break a
 * publish: a missing sample only means a call reports no resource, which is
 * exactly what it did before anything was sampled at all.
 */
export async function refreshMcpLoad(
  sessions: readonly SessionInfo[],
  now: number = Date.now(),
): Promise<void> {
  try {
    const servers = configuredMcpCommands(sessions);
    if (servers.length === 0) return;
    recordMcpLoad(attributeMcpProcesses(await sampleProcessRows(), servers), now);
  } catch {
    // Leave the previous sample to expire on its own.
  }
}
