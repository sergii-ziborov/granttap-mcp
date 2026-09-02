import type { SessionInfo } from "../../../../packages/protocol/schema";
import { descriptorsForSession } from "../capabilities/descriptors";
import { attributeMcpProcesses, type McpServerCommand } from "./mcp-process-sampler";
import { recordMcpLoad } from "./mcp-load-cache";
import { recordAgentLoad } from "./agent-load-history";
import { attributeProcesses, sampleProcessRows } from "./process-sampler";

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
 * How many calls each agent could have had in flight, counted per agent.
 *
 * A working session is one lane, and every working sub-agent under it is
 * another: they share the same processes, so they share what those processes
 * cost. Sessions that are not working are not counted, because a call is only
 * ever attributed to a moment when something was running.
 */
export function agentLanes(sessions: readonly SessionInfo[]): Record<string, number> {
  const lanes: Record<string, number> = {};
  for (const session of sessions) {
    const working = (session.state === "working" ? 1 : 0)
      + (session.childThreads?.filter((child) => child.state === "working").length ?? 0);
    if (working === 0) continue;
    lanes[session.agent] = (lanes[session.agent] ?? 0) + working;
  }
  return lanes;
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
    const rows = await sampleProcessRows();
    // Agents first: a built-in tool has nothing left to inspect once it ends,
    // so the running sample is the only description its call will ever get.
    recordAgentLoad(attributeProcesses(rows), now, agentLanes(sessions));
    const servers = configuredMcpCommands(sessions);
    if (servers.length === 0) return;
    recordMcpLoad(attributeMcpProcesses(rows, servers), now);
  } catch {
    // Leave the previous sample to expire on its own.
  }
}
