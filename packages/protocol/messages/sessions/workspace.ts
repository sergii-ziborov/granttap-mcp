import { z } from 'zod';
const scope = { sessionId: z.string().min(1).max(512), requestId: z.string().min(1).max(128) };
export const SessionWorkspaceQuery = z.object({ type: z.literal('session.workspace.query'), ...scope,
    mode: z.enum(['directory', 'file']), path: z.string().max(4096), offset: z.number().int().nonnegative().optional(),
    createdAt: z.number().finite() }).strict();
export type SessionWorkspaceQuery = z.infer<typeof SessionWorkspaceQuery>;
export const SessionWorkspaceResult = z.object({ type: z.literal('session.workspace.result'), ...scope,
    path: z.string().max(4096), entries: z.array(z.object({ path: z.string().max(4096), name: z.string().max(1024),
        kind: z.enum(['directory', 'file']), size: z.number().int().nonnegative().optional() }).strict()).max(200).optional(),
    text: z.string().max(128 * 1024).optional(), truncated: z.boolean(),
    nextOffset: z.number().int().nonnegative().optional(), unavailable: z.boolean().optional(),
    createdAt: z.number().finite() }).strict();
export type SessionWorkspaceResult = z.infer<typeof SessionWorkspaceResult>;
