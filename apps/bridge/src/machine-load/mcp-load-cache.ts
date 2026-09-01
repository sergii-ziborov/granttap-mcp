import type { AgentProcessLoad } from "./process-sampler";
import type { CapabilityResourceUsage } from "../../../../packages/protocol/messages/capabilities";

/**
 * The most recent MCP server sample, for calls that just finished.
 *
 * A tool call is read back from a transcript after it ended, so its own cost
 * cannot be measured. What can be said honestly is what its server was using
 * around that time, and only while the sample is still about that moment — an
 * older call is left with nothing rather than the wrong number.
 */
const FRESH_FOR_MS = 90_000;

let sampledAt = 0;
let byServer: Record<string, AgentProcessLoad> = {};

export function recordMcpLoad(load: Record<string, AgentProcessLoad>, now: number): void {
  byServer = load;
  sampledAt = now;
}

export function clearMcpLoad(): void {
  byServer = {};
  sampledAt = 0;
}

/**
 * What the named server was costing when a call ending at `endedAt` ran, or
 * undefined when nothing observed can speak for that moment.
 */
export function attributedMcpResource(
  server: string,
  endedAt: number,
  now: number,
): CapabilityResourceUsage | undefined {
  const load = byServer[server];
  if (!load || sampledAt === 0) return undefined;
  if (now - sampledAt > FRESH_FOR_MS) return undefined;
  if (Math.abs(sampledAt - endedAt) > FRESH_FOR_MS) return undefined;
  return {
    // Sampled from the server's own processes, not from the call itself.
    attribution: "attributed",
    peakRssBytes: load.memoryBytes > 0 ? load.memoryBytes : undefined,
    processCount: load.processes > 0 ? load.processes : undefined,
  };
}
