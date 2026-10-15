import type { ActivityEntry, SessionInfo } from '../../../../../packages/protocol/schema';
import { nativeTranscriptImage } from '../../transcript-history';
import type { TransferArchive } from './archive';

type ImageReader = typeof nativeTranscriptImage;

export function captureContextImages(session: SessionInfo, entry: ActivityEntry, cursor: string | undefined,
  read: ImageReader = nativeTranscriptImage): NonNullable<TransferArchive['entries'][number]['images']> {
  const images = entry.images?.length ? entry.images
    : entry.attachments?.length === 1 && entry.attachments[0] === 'Image'
      ? [{ id: entry.id, name: 'Image', markdown: '' }] : [];
  if ((entry.attachments?.length ?? 0) > images.length) {
    throw new Error('An attachment could not be recovered. No partial transfer was sent.');
  }
  return images.map(image => {
    let offset = 0, total = 0, mime = '';
    const chunks: Buffer[] = [];
    do {
      const chunk = read(session, image.id, offset, cursor);
      if (!chunk || chunk.offset !== offset || chunk.total_bytes > 8 * 1_024 * 1_024
        || (offset && (chunk.total_bytes !== total || chunk.mime_type !== mime))) {
        throw new Error('An image could not be fully recovered. No partial transfer was sent.');
      }
      total = chunk.total_bytes; mime = chunk.mime_type;
      const bytes = Buffer.from(chunk.data_base64, 'base64');
      if (!bytes.length || offset + bytes.length > total) throw new Error('An image transfer is incomplete.');
      chunks.push(bytes); offset += bytes.length;
    } while (offset < total);
    return { id: image.id, name: image.name, mime: mime as 'image/png' | 'image/jpeg' | 'image/webp',
      data: Buffer.concat(chunks).toString('base64') };
  });
}
