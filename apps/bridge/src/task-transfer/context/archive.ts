import { z } from 'zod';
import { TaskCapsule } from '../../../../../packages/protocol/schema';

export const ContextImage = z.object({ id: z.string().max(512), name: z.string().max(256),
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp']), data: z.string().max(11_200_000) }).strict();
export const TransferArchive = z.object({ version: z.literal(1), facts: TaskCapsule,
  entries: z.array(z.object({ id: z.string().max(1_024), role: z.enum(['user', 'assistant', 'tool', 'status']),
    text: z.string().max(16_000_000), at: z.number().nonnegative(),
    images: z.array(ContextImage).max(32).optional() }).strict()).max(50_000) }).strict();
export type TransferArchive = z.infer<typeof TransferArchive>;
