import { z } from 'zod';
import { TaskCreate, UserMessage } from '../messages/interaction';

/** Signed scheduling and acceptance proof live inside authenticated ciphertext. */
export const TaskDispatch = z.object({
  type: z.literal('task.dispatch'),
  origin: z.enum(['controller', 'computer']).optional(),
  deliveryMode: z.enum(['when_idle', 'immediate']).optional(),
  jobId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  sessionId: z.string().min(1).max(180).optional(),
  notBefore: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  operation: z.union([UserMessage, TaskCreate]),
}).strict().superRefine((job, context) => {
  const reject = (message: string, path: string[]) => context.addIssue({
    code: z.ZodIssueCode.custom, message, path,
  });
  if (job.expiresAt <= job.notBefore || job.notBefore < job.createdAt - 300_000
    || job.expiresAt - job.createdAt > 30 * 86_400_000) {
    reject('Invalid durable task schedule', ['notBefore']);
  }
  if (job.operation.type === 'user.message') {
    if (!job.operation.messageId || job.operation.requestId) {
      reject('A queued message requires its own message ID and cannot answer an approval', ['operation']);
    }
    if (job.sessionId !== job.operation.sessionId) {
      reject('Task encryption scope must match the queued conversation', ['sessionId']);
    }
  } else if (job.sessionId !== undefined) {
    reject('New tasks cannot borrow an existing conversation encryption scope', ['sessionId']);
  }
  if (job.operation.attachmentRefs?.length) {
    reject('Durable tasks must carry their attachments inline', ['operation', 'attachmentRefs']);
  }
  if ((!job.operation.text.trim() && !job.operation.attachments?.length) || job.operation.text.length > 32_000) {
    reject('Durable task text must be present and bounded', ['operation', 'text']);
  }
});
export type TaskDispatch = z.infer<typeof TaskDispatch>;
