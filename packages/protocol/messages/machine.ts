import { z } from "zod";
import { AgentId } from "./primitives";

const Amount = z.number().nonnegative().catch(0);
const Count = z.number().int().nonnegative().catch(0);

/** Measurements for one local coding-agent process family. */
/** One kind of process an agent runs — `node` ×43, `zsh` ×10 — and what it costs. */
export const ProcessGroupLoad = z.object({
  name: z.string().trim().min(1).max(64),
  count: Count,
  cpuPercent: Amount,
  memoryBytes: Amount,
});
export type ProcessGroupLoad = z.infer<typeof ProcessGroupLoad>;

export const AgentLoadSample = z.object({
  agent: AgentId,
  processes: Count,
  cpuPercent: Amount,
  memoryBytes: Amount,
  // The heaviest kinds of process behind the agent's number, so the phone
  // can say what "Claude" is running, not only that it is running.
  topProcesses: z.array(ProcessGroupLoad).max(8).optional(),
  sessions: Count,
  scanMs: Amount,
  tokensRecent: Amount,
  contextTokens: Amount.nullish(),
});
export type AgentLoadSample = z.infer<typeof AgentLoadSample>;

/** A transient, bounded snapshot consumed by the iPhone connection sheet. */
export const MachineLoad = z.object({
  type: z.literal("machine.load"),
  machine: z.string(),
  monitorCpuPercent: Amount,
  monitorMemoryBytes: Amount,
  agents: z.array(AgentLoadSample).max(16),
  generatedAt: z.number(),
});
export type MachineLoad = z.infer<typeof MachineLoad>;
