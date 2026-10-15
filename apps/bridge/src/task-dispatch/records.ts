import { z } from 'zod';
import { TaskDispatch } from '../../../../packages/protocol/schema';

export const RequestRecord = z.object({
  room: z.string().min(1).max(180),
  peerPublicKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  job: TaskDispatch,
  stagedAt: z.number().int().nonnegative(),
}).strict();
export type RequestRecord = z.infer<typeof RequestRecord>;

export const InboxState = z.object({
  phase: z.enum(['staged', 'claimed', 'running', 'uncertain', 'delivered', 'failed', 'rejected', 'completed', 'cancelled']),
  updatedAt: z.number().int().nonnegative(),
  claimId: z.string().uuid().optional(),
  nativeAttemptId: z.string().min(1).max(180).optional(),
  nativeSessionId: z.string().min(1).max(180).optional(),
  code: z.string().min(1).max(80).optional(),
}).strict();
export type InboxState = z.infer<typeof InboxState>;
export type InboxPhase = InboxState['phase'];
export type StoredTaskDispatch = RequestRecord & InboxState;

export const phaseTransitions: Record<InboxPhase, InboxPhase[]> = {
  staged: ['claimed', 'failed', 'cancelled'],
  claimed: ['running', 'failed', 'cancelled'],
  running: ['delivered', 'uncertain', 'failed'],
  uncertain: ['delivered', 'failed', 'rejected', 'cancelled'],
  delivered: ['completed'], failed: ['rejected', 'completed'], rejected: ['cancelled'], cancelled: [], completed: [],
};
