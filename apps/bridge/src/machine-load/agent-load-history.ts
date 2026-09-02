import type { CapabilityResourceUsage } from "../../../../packages/protocol/messages/capabilities";
import type { AgentProcessLoad } from "./process-sampler";

/**
 * What each agent's processes were costing, over a short rolling window.
 *
 * A tool call is read back from a transcript once it has finished, so it can
 * never be measured directly — but the call has a start and an end, and the
 * samples taken between them describe the machine while it ran. Integrating
 * those samples is the only honest answer to "what did this call cost", and it
 * is why the result is reported as attributed rather than measured.
 *
 * Built-in tools are the reason this exists at all: a Bash call is a child of
 * the agent that lives for seconds, so nothing survives afterwards to inspect.
 */
export type AgentLoadSample = { at: number; byAgent: Record<string, AgentProcessLoad> };

/** Two hours at a thirty-second cadence, so a long session still has a tail. */
const MAX_SAMPLES = 240;
/** A window with no sample near it is not described by the ones far from it. */
const MAX_GAP_MS = 120_000;

let samples: AgentLoadSample[] = [];

export function recordAgentLoad(byAgent: Record<string, AgentProcessLoad>, at: number): void {
  samples.push({ at, byAgent });
  if (samples.length > MAX_SAMPLES) samples = samples.slice(-MAX_SAMPLES);
}

export function clearAgentLoad(): void {
  samples = [];
}

/**
 * Integrate the samples covering a call into the cost of that call.
 *
 * CPU percent is a rate, so it is multiplied by the time each sample stands
 * for; memory is a level, so the largest is taken. A call with no sample near
 * it reports nothing at all rather than a number borrowed from another moment.
 */
export function attributedAgentResource(
  agent: string,
  startedAt: number,
  endedAt: number,
): CapabilityResourceUsage | undefined {
  if (!(endedAt > startedAt)) return undefined;
  const covering = samples.filter((sample) =>
    sample.at >= startedAt - MAX_GAP_MS && sample.at <= endedAt + MAX_GAP_MS
    && sample.byAgent[agent] != null);
  if (covering.length === 0) return undefined;

  const span = endedAt - startedAt;
  const share = span / covering.length;
  let cpuMs = 0;
  let peak = 0;
  let processes = 0;
  for (const sample of covering) {
    const load = sample.byAgent[agent]!;
    cpuMs += (load.cpuPercent / 100) * share;
    peak = Math.max(peak, load.memoryBytes);
    processes = Math.max(processes, load.processes);
  }
  const rounded = Math.round(cpuMs);
  if (rounded <= 0 && peak <= 0) return undefined;
  return {
    attribution: "attributed",
    cpuTimeMs: rounded > 0 ? rounded : undefined,
    peakRssBytes: peak > 0 ? peak : undefined,
    processCount: processes > 0 ? processes : undefined,
  };
}
