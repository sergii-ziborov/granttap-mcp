import { z } from 'zod';

const identifier = z.string().min(1).max(128);
const stamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const model = z.object({ id: z.string().min(1).max(160), observedAt: stamp,
  efforts: z.array(z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])).max(6).optional() }).strict();

export const TaskRoutingNeeds = z.object({ portable: z.boolean(),
  minAvailableMemoryBytes: z.number().int().min(1).max(512 * 2 ** 30),
  minAvailableDiskBytes: z.number().int().min(1).max(2 * 2 ** 40),
  gpuVendor: z.enum(['nvidia', 'amd', 'apple', 'intel']).optional(),
  minGpuMemoryBytes: z.number().int().min(1).max(512 * 2 ** 30).optional(),
  requiredTools: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,63}$/)).max(16) }).strict();

/** Encrypted, short-lived capacity observations, distinct from policy and confirmed usage. */
export const TaskResourceReport = z.object({ type: z.literal('mesh.resources'),
  projectId: identifier, endpointId: identifier, policyRevision: z.number().int().nonnegative(),
  generatedAt: stamp, expiresAt: stamp, routingEnabled: z.boolean(),
  repositoryId: z.string().min(1).max(512), revision: z.string().regex(/^[a-f0-9]{40,64}$/),
  revisions: z.array(z.string().regex(/^[a-f0-9]{40,64}$/)).max(64).optional(),
  os: z.enum(['darwin', 'win32', 'linux']), architecture: z.string().min(1).max(32),
  cpuUtilization: z.number().finite().min(0).max(1).optional(),
  availableMemoryBytes: amount.optional(), availableDiskBytes: amount.optional(),
  gpu: z.object({ vendor: z.string().min(1).max(32), available: z.boolean(), memoryBytes: amount.optional() }).strict().optional(),
  tools: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,63}$/)).max(32),
  providers: z.array(z.object({ provider: z.enum(['claude', 'codex', 'cursor', 'grok']),
    ready: z.boolean(), models: z.array(model).max(64), quotaExhausted: z.boolean().optional() }).strict()).max(4),
}).strict().refine(value => value.expiresAt > value.generatedAt
  && value.expiresAt - value.generatedAt <= 90_000
  && new Set(value.providers.map(row => row.provider)).size === value.providers.length
  && new TextEncoder().encode(JSON.stringify(value)).length <= 21_000);
export type TaskResourceReport = z.infer<typeof TaskResourceReport>;
