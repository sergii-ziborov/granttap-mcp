import { z } from 'zod';
const Identifier = z.string().min(1).max(256);
export const TaskTransferNotice = z.object({ sourceSessionId: Identifier, targetSessionId: Identifier.optional(),
  projectId: Identifier, taskId: Identifier, capsuleHash: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(['pending', 'accepted']).optional(), targetComputerId: Identifier.optional(),
  targetProvider: z.string().max(64).optional(), queuedAt: z.number().finite().nonnegative().optional(),
  acceptedAt: z.number().finite().nonnegative().optional(), continuedAt: z.number().finite().nonnegative().optional(),
}).strict().refine(notice => notice.phase === 'pending'
  ? notice.queuedAt !== undefined && notice.targetComputerId !== undefined && notice.acceptedAt === undefined && notice.targetSessionId === undefined
  : notice.acceptedAt !== undefined && notice.targetSessionId !== undefined, 'Invalid transfer confirmation phase');
export type TaskTransferNotice = z.infer<typeof TaskTransferNotice>;
const Scope = { sessionId: Identifier, projectId: Identifier, taskId: Identifier,
  capsuleHash: z.string().regex(/^[a-f0-9]{64}$/), requestId: Identifier, createdAt: z.number().nonnegative() };
export const TaskTransferContinue = z.object({ type: z.literal('task.transfer.continue'), ...Scope }).strict();
export type TaskTransferContinue = z.infer<typeof TaskTransferContinue>;
export const TaskTransferContinueResult = z.object({ type: z.literal('task.transfer.continued'), ...Scope,
  accepted: z.boolean(), notice: TaskTransferNotice.optional() }).strict();
export type TaskTransferContinueResult = z.infer<typeof TaskTransferContinueResult>;
