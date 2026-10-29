import { z } from 'zod';
import { TaskCapsule } from '../../../../packages/protocol/schema';

export const PreparedTransfer = z.object({
  version: z.literal(1), eventId: z.string().min(1).max(128), sessionId: z.string(),
  projectId: z.string().min(1).max(128), sourceSessionId: z.string().min(1).max(128),
  title: z.string().min(1).max(160), capsule: TaskCapsule,
  workspace: z.string().min(1).max(1_024), branch: z.string().min(1).max(512).optional(),
  contextHash: z.string().regex(/^[a-f0-9]{64}$/), acceptedAt: z.number().nonnegative(),
  phase: z.enum(['prepared', 'starting', 'active', 'uncertain']),
  ownerPid: z.number().int().positive().optional(),
  nativeSessionId: z.string().min(1).max(256).optional(), updatedAt: z.number().nonnegative(),
}).strict();
export type PreparedTransfer = z.infer<typeof PreparedTransfer>;
export type TransferPreparation = Omit<PreparedTransfer,
  'ownerPid' | 'version' | 'sessionId' | 'contextHash' | 'phase' | 'nativeSessionId' | 'updatedAt'> & { context: string };
