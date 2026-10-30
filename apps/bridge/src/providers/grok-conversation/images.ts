import type { ActivityEntry } from '../../../../../packages/protocol/schema';

export type ConversationImage = { bytes: Buffer; mime: string };

/** Native image bytes remain private to the capture and are never put in a catalog. */
export function conversationImage(content: Record<string, unknown>, sessionId: string, offset: number, at: number) {
  const mime = content.mimeType ?? content.mime_type;
  if (typeof content.data !== 'string' || content.data.length > 11_200_000
    || !['image/png', 'image/jpeg', 'image/webp'].includes(String(mime))) return undefined;
  const bytes = Buffer.from(content.data, 'base64');
  if (!bytes.length || bytes.length > 8 * 1024 * 1024 || bytes.toString('base64') !== content.data) return undefined;
  const valid = mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mime === 'image/jpeg' ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) return undefined;
  const id = `${sessionId}:native-image:${offset}`;
  const entry: ActivityEntry = { id, kind: 'user', text: '[Image]', createdAt: at,
    attachments: ['Image'], images: [{ id, name: 'Image', markdown: `![Image](granttap-image:${id})` }] };
  return { entry, image: { bytes, mime: String(mime) }, encodedBytes: content.data.length };
}
