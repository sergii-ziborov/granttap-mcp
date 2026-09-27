import { hostname } from "node:os";
import {
  sampleAgentProcesses, type AgentProcessLoad,
} from "../../../../bridge/src/machine-load/host/process-sampler";

/** A bounded, read-only sample of coding-agent processes on this computer. */
export async function desktopMachineLoad(
  sample: () => Promise<Record<string, AgentProcessLoad>> = sampleAgentProcesses,
  now: () => number = Date.now,
) {
  const processes = await sample();
  return {
    operation: "desktop.machine_load" as const,
    source: "process_sample" as const,
    computer: hostname(),
    observed_at: now(),
    agents: Object.entries(processes)
      .filter(([agent]) => agent.length > 0)
      .map(([agent, value]) => ({
        agent,
        processes: value.processes,
        cpu_percent: value.cpuPercent,
        memory_bytes: value.memoryBytes,
        groups: (value.groups ?? []).slice(0, 8).map((group) => ({
          name: group.name,
          count: group.count,
          cpu_percent: group.cpuPercent,
          memory_bytes: group.memoryBytes,
        })),
      }))
      .sort((a, b) => b.cpu_percent - a.cpu_percent)
      .slice(0, 16),
  };
}
