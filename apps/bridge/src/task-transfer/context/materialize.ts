import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivateFile } from '../../config/access/write-private';
import { TransferArchive } from './archive';
import { writeTransferProjection } from '../projection/storage';

/** Provider prompts reference readable history and private image files, never base64 megabytes. */
export function materializeTransferContext(context: string, directory: string, id: string): string {
  const path = join(directory, `${id}.conversation.md`);
  let parsed: unknown;
  try { parsed = JSON.parse(context); } catch { writePrivateFile(path, context); return path; }
  const archive = TransferArchive.parse(parsed);
  const imageDirectory = join(directory, `${id}.images`);
  const lines = ['# GrantTap Task facts', JSON.stringify(archive.facts, null, 2), '# Visible conversation'];
  let imageNumber = 0, imageBytes = 0;
  const imageFiles: Parameters<typeof writeTransferProjection>[3] = [];
  for (const entry of archive.entries) {
    lines.push(`## ${entry.role.toUpperCase()} (${entry.at})`, entry.text);
    for (const image of entry.images ?? []) {
      const bytes = Buffer.from(image.data, 'base64');
      imageBytes += bytes.length;
      if (!bytes.length || bytes.length > 8 * 1_024 * 1_024 || imageBytes > 11_000_000
        || bytes.toString('base64') !== image.data) throw new Error('The transfer image archive is invalid.');
      mkdirSync(imageDirectory, { recursive: true, mode: 0o700 });
      const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[image.mime];
      const file = join(imageDirectory, `${imageNumber++}.${extension}`);
      writeFileSync(file, bytes, { mode: 0o600 }); chmodSync(file, 0o600);
      imageFiles.push({ id: image.id, file: `${imageNumber - 1}.${extension}`, mime: image.mime, bytes: bytes.length });
      lines.push(`Image ${JSON.stringify(image.name)}: ${JSON.stringify(file)}`);
    }
  }
  const entries = archive.entries.map(({ images, ...entry }) => ({ ...entry,
    ...(images?.length ? { images: images.map(({ data: _data, ...image }) => image) } : {}) }));
  writeTransferProjection(directory, id, entries, imageFiles);
  writePrivateFile(path, lines.join('\n\n')); return path;
}
