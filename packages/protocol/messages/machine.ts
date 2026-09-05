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

/** One process on its own: who, in the list a person opens, eats what. */
export const ProcessLoadRow = z.object({
  pid: Count,
  name: z.string().trim().min(1).max(64),
  cpuPercent: Amount,
  memoryBytes: Amount,
  detail: z.string().trim().min(1).max(160).optional(),
  sessionId: z.string().trim().min(1).max(256).optional(),
});
export type ProcessLoadRow = z.infer<typeof ProcessLoadRow>;

/** What one chat's processes cost together. */
export const ChatProcessLoad = z.object({
  sessionId: z.string().trim().min(1).max(256),
  processes: Count,
  cpuPercent: Amount,
  memoryBytes: Amount,
});
export type ChatProcessLoad = z.infer<typeof ChatProcessLoad>;

export const DiskUsageEntry = z.object({
  path: z.string().trim().min(1).max(512),
  bytes: Amount,
});
export type DiskUsageEntry = z.infer<typeof DiskUsageEntry>;

/** What the agent keeps on the disk: its own folders, heaviest places first. */
export const AgentDiskUsage = z.object({
  measuredAt: z.number(),
  totalBytes: Amount,
  entries: z.array(DiskUsageEntry).max(16),
});
export type AgentDiskUsage = z.infer<typeof AgentDiskUsage>;

export const AgentLoadSample = z.object({
  agent: AgentId,
  processes: Count,
  cpuPercent: Amount,
  memoryBytes: Amount,
  // The heaviest kinds of process behind the agent's number, so the phone
  // can say what "Claude" is running, not only that it is running.
  topProcesses: z.array(ProcessGroupLoad).max(8).optional(),
  // The heaviest processes one by one, and the same load by chat, so the
  // number can be opened rather than only read.
  processList: z.array(ProcessLoadRow).max(48).optional(),
  chats: z.array(ChatProcessLoad).max(64).optional(),
  disk: AgentDiskUsage.optional(),
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
