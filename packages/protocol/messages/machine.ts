import { z } from "zod";
import { AgentId } from "./primitives";

const Amount = z.number().nonnegative().catch(0);
const Count = z.number().int().nonnegative().catch(0);

/** Measurements for one local coding-agent process family. */
export const AgentLoadSample = z.object({
  agent: AgentId,
  processes: Count,
  cpuPercent: Amount,
  memoryBytes: Amount,
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
