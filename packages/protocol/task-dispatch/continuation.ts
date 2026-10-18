import { z } from 'zod';
import { UserMessage } from '../messages/interaction';
import { CodingAgent } from '../messages/primitives';

/** A separate operation fails closed on receivers that do not support origin routing. */
export const TaskContinuation = UserMessage.omit({ type: true, sessionId: true, requestId: true, cwd: true,
  taskOriginId: true, retryId: true })
  .extend({ type: z.literal('user.message.continue'), agent: CodingAgent,
    messageId: z.string().min(1).max(180), originMessageId: z.string().min(1).max(180) }).strict();
