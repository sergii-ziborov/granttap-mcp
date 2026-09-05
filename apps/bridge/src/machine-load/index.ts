import { hostname } from "node:os";
import type {
  MachineLoad,
  SessionsStatus,
} from "../../../../packages/protocol/schema";
import type { AgentProcessLoad } from "./process-sampler";
import { sampleAgentProcesses } from "./process-sampler";
import { providerScanCost, type ProviderScanSample } from "./scan-cost";

export type MonitorSelfLoad = {
  cpuPercent: number;
  memoryBytes: number;
};

export const LOAD_WINDOW_MS = 30_000;

/** Average the monitor's cumulative CPU time over a stable Activity Monitor-like window. */
export function monitorLoadSampler(
  readCpu: () => NodeJS.CpuUsage = () => process.cpuUsage(),
  readMemory: () => number = () => process.memoryUsage().rss,
  now: () => number = () => Date.now(),
  windowMs: number = LOAD_WINDOW_MS,
): () => MonitorSelfLoad {
  let lastCpu = readCpu();
  let lastAt = now();
  let lastPercent = 0;
  return () => {
    const at = now();
    const elapsedMs = at - lastAt;
    if (elapsedMs >= windowMs) {
      const cpu = readCpu();
      const usedMs = (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1_000;
      lastCpu = cpu;
      lastAt = at;
      lastPercent = Math.max(0, Math.round((usedMs / elapsedMs) * 1_000) / 10);
    }
    return { cpuPercent: lastPercent, memoryBytes: readMemory() };
  };
}

/** Build independent process, catalog, scan, and monitor measurements. */
export function buildMachineLoad(input: {
  status: SessionsStatus;
  processes: Record<string, AgentProcessLoad>;
  self: MonitorSelfLoad;
  scanCost?: Record<string, ProviderScanSample>;
  machine?: string;
  now?: number;
}): MachineLoad {
  const scanCost = input.scanCost ?? providerScanCost();
  const catalog = [...input.status.sessions, ...(input.status.history ?? [])];
  const unique = new Map(catalog.map((session) => [
    `${session.agent}\0${session.sessionId}`,
    session,
  ]));
  const sessionsByAgent = new Map<string, number>();
  const tokensByAgent = new Map<string, number>();
  const contextByAgent = new Map<string, number>();
  for (const session of unique.values()) {
    sessionsByAgent.set(session.agent, (sessionsByAgent.get(session.agent) ?? 0) + 1);
    tokensByAgent.set(
      session.agent,
      (tokensByAgent.get(session.agent) ?? 0) + session.tokensSession,
    );
    contextByAgent.set(
      session.agent,
      (contextByAgent.get(session.agent) ?? 0) + (session.contextTokensUsed ?? 0),
    );
  }
  const agents = new Set([
    ...sessionsByAgent.keys(),
    ...Object.keys(input.processes),
    ...Object.keys(scanCost),
  ]);
  return {
    type: "machine.load",
    machine: input.machine ?? hostname(),
    monitorCpuPercent: input.self.cpuPercent,
    monitorMemoryBytes: input.self.memoryBytes,
    agents: [...agents]
      .filter(Boolean)
      .map((agent) => ({
        agent,
        processes: input.processes[agent]?.processes ?? 0,
        cpuPercent: input.processes[agent]?.cpuPercent ?? 0,
        memoryBytes: input.processes[agent]?.memoryBytes ?? 0,
        topProcesses: input.processes[agent]?.groups ?? [],
        sessions: sessionsByAgent.get(agent) ?? 0,
        scanMs: scanCost[agent]?.durationMs ?? 0,
        tokensRecent: tokensByAgent.get(agent) ?? 0,
        contextTokens: contextByAgent.get(agent) ?? 0,
      }))
      .sort((a, b) => (b.cpuPercent - a.cpuPercent) || (b.scanMs - a.scanMs))
      .slice(0, 16),
    generatedAt: input.now ?? Date.now(),
  };
}

type LoadRelay = {
  send(
    payload: MachineLoad,
    to: "phone",
    options: { ttlMs: number; reliable: false },
  ): Promise<void>;
};

/** Create one publisher so its monitor CPU baseline survives between reports. */
export function createMachineLoadPublisher(dependencies: {
  sampleProcesses?: typeof sampleAgentProcesses;
  sampleSelf?: () => MonitorSelfLoad;
} = {}) {
  const sampleProcesses = dependencies.sampleProcesses ?? sampleAgentProcesses;
  const sampleSelf = dependencies.sampleSelf ?? monitorLoadSampler();
  let active: Promise<MachineLoad> | undefined;
  return (
    client: LoadRelay,
    status: SessionsStatus,
    intervalMs: number,
  ): Promise<MachineLoad> => {
    if (active) return active;
    active = (async () => {
      const processes = await sampleProcesses();
      const load = buildMachineLoad({ status, processes, self: sampleSelf() });
      await client.send(load, "phone", { ttlMs: intervalMs * 3, reliable: false });
      return load;
    })().finally(() => {
      active = undefined;
    });
    return active;
  };
}
