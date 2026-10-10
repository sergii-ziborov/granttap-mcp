import { z } from 'zod';

const Scope = {
  sessionId: z.string().min(1).max(512), requestId: z.string().min(1).max(128),
  imageId: z.string().min(1).max(512), offset: z.number().int().min(0).max(8 * 1024 * 1024),
};

export const SessionImageQuery = z.object({ type: z.literal('session.image.query'), ...Scope,
  historyCursor: z.string().max(512).optional(), createdAt: z.number().finite() });
export type SessionImageQuery = z.infer<typeof SessionImageQuery>;

export const SessionImageChunk = z.object({ type: z.literal('session.image.chunk'), ...Scope,
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']).optional(),
  totalBytes: z.number().int().min(1).max(8 * 1024 * 1024).optional(),
  dataBase64: z.string().max(90_000).optional(), unavailable: z.boolean().optional(),
}).refine(value => {
  if (value.unavailable) return value.dataBase64 === undefined;
  if (!value.mimeType || !value.totalBytes || !value.dataBase64
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.dataBase64)) return false;
  const bytes = Buffer.from(value.dataBase64, 'base64');
  return bytes.length > 0 && bytes.length <= 64 * 1024
    && value.offset + bytes.length <= value.totalBytes;
});
export type SessionImageChunk = z.infer<typeof SessionImageChunk>;
