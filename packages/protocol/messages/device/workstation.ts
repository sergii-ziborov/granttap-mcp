import { z } from 'zod';

const Bytes = z.number().int().nonnegative();
const label = (max: number) => z.string().trim().min(1).max(max);

/** One live app or agent and what it holds now; `name` is its app bundle or executable. */
export const WorkstationApp = z.object({
  kind: label(40), name: label(80).optional(), processes: z.number().int().nonnegative(),
  memoryBytes: Bytes, cpuPercent: z.number().nonnegative(), project: label(160).optional(),
}).strict();

/** Load of the computer as a whole. `source: basic` means the Engine could not be asked. */
export const WorkstationLoad = z.object({
  observedAt: z.number().finite(), source: z.enum(['engine', 'basic']),
  memoryTotalBytes: Bytes, memoryUsedBytes: Bytes.optional(),
  swapTotalBytes: Bytes.optional(), swapUsedBytes: Bytes.optional(),
  cpuPercent: z.number().nonnegative().max(100).optional(), logicalCores: z.number().int().positive(),
  diskTotalBytes: Bytes, diskAvailableBytes: Bytes,
  apps: z.array(WorkstationApp).max(8),
}).strict();
export type WorkstationLoad = z.infer<typeof WorkstationLoad>;

export const WorkstationSpaceItem = z.object({
  title: label(160), path: label(240), bytes: Bytes,
  kind: z.enum(['regenerable', 'history', 'protected', 'context', 'user-data', 'inspect']),
  partial: z.boolean().optional(),
}).strict();

export const WorkstationSpaceGroup = z.object({
  id: label(80), title: label(80),
  section: z.enum(['agents', 'projects', 'caches', 'models', 'data', 'system']),
  bytes: Bytes, regenerableBytes: Bytes, partial: z.boolean().optional(),
  items: z.array(WorkstationSpaceItem).max(6),
}).strict();

/** Where the space went at `scannedAt`. Measured only; nothing was deleted. */
export const WorkstationSpace = z.object({
  scannedAt: z.number().finite(), durationMs: z.number().int().nonnegative(), complete: z.boolean(),
  trigger: z.enum(['manual', 'agent', 'daily', 'low-space', 'space-drop']),
  /** `folders`: the Engine could not measure, so only coding-agent folders were. */
  source: z.enum(['engine', 'folders']),
  diskAvailableBytes: Bytes.optional(),
  groups: z.array(WorkstationSpaceGroup).max(16),
}).strict();
export type WorkstationSpace = z.infer<typeof WorkstationSpace>;

/** `smart` measures when space runs low, drops sharply, or once a day on an idle charger. */
export const WorkstationSettings = z.object({
  automaticScan: z.enum(['smart', 'off']),
  lowSpaceAlert: z.boolean(),
}).strict();
export type WorkstationSettings = z.infer<typeof WorkstationSettings>;

export const WorkstationSnapshot = z.object({
  load: WorkstationLoad,
  space: WorkstationSpace.optional(),
  scanning: z.boolean(),
  /** The installed Engine can measure the whole disk, not only agent folders. */
  fullScanSupported: z.boolean(),
  lowSpace: z.enum(['ok', 'low', 'critical']),
  settings: WorkstationSettings,
}).strict();
export type WorkstationSnapshot = z.infer<typeof WorkstationSnapshot>;
