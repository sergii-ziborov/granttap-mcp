import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { writePrivateFile } from '../../config/access/write-private';
import type { TransferArchive } from '../context/archive';

type Image = Omit<NonNullable<TransferArchive['entries'][number]['images']>[number], 'data'>;
type Entry = Omit<TransferArchive['entries'][number], 'images'> & { images?: Image[] };
const digest = (id: string) => createHash('sha256').update(id).digest('hex');
const Index = z.object({ version: z.literal(1), count: z.number().int().min(0).max(50_000) });
const StoredImage = z.object({ file: z.string().regex(/^\d+\.(png|jpg|webp)$/),
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp']), bytes: z.number().int().positive().max(8 * 1_024 * 1_024) });

/** Immutable, private read projection; the large context archive stays off the catalog hot path. */
export function writeTransferProjection(directory: string, id: string, entries: Entry[],
  images: Array<{ id: string; file: string; mime: Image['mime']; bytes: number }>): void {
  const root = join(directory, `${id}.projection`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (let from = 0; from < entries.length; from += 40) {
    writePrivateFile(join(root, `page-${from / 40}.json`), JSON.stringify(entries.slice(from, from + 40)));
  }
  for (const image of images) {
    writePrivateFile(join(root, `image-${digest(image.id)}.json`), JSON.stringify(image));
  }
  writePrivateFile(join(root, 'index.json'), JSON.stringify({ version: 1, count: entries.length }));
}

function smallJSON(path: string, limit: number): unknown {
  if (statSync(path).size > limit) throw new Error('Projection exceeds its bound.');
  return JSON.parse(readFileSync(path, 'utf8'));
}

export class TransferProjection {
  private readonly root: string;
  constructor(private readonly directory: string, private readonly id: string) {
    if (!/^transfer-[a-f0-9]{48}$/.test(id)) throw new Error('Invalid transfer projection identity.');
    this.root = join(directory, `${id}.projection`);
  }
  page(until?: number): { entries: Entry[]; from: number; total: number } | undefined {
    try {
      const { count } = Index.parse(smallJSON(join(this.root, 'index.json'), 1_024));
      const end = until ?? count;
      if (!Number.isSafeInteger(end) || end < 0 || end > count) return undefined;
      const from = Math.max(0, end - 40), entries: Entry[] = [];
      for (let page = Math.floor(from / 40); page < Math.ceil(end / 40); page++) {
        const rows = smallJSON(join(this.root, `page-${page}.json`), 16_000_000) as Entry[];
        if (!Array.isArray(rows) || rows.length > 40) return undefined;
        entries.push(...rows.slice(Math.max(0, from - page * 40), Math.min(rows.length, end - page * 40)));
      }
      if (entries.length !== end - from) return undefined;
      return { entries, from, total: count };
    } catch { return undefined; }
  }
  image(imageId: string, offset: number): { mime_type: string; total_bytes: number; data_base64: string; offset: number } | undefined {
    if (!Number.isSafeInteger(offset) || offset < 0 || imageId.length > 512) return undefined;
    try {
      const image = StoredImage.parse(smallJSON(join(this.root, `image-${digest(imageId)}.json`), 2_048));
      if (offset >= image.bytes) return undefined;
      const fd = openSync(join(this.directory, `${this.id}.images`, image.file), 'r');
      try {
        const bytes = Buffer.alloc(Math.min(64 * 1_024, image.bytes - offset));
        if (readSync(fd, bytes, 0, bytes.length, offset) !== bytes.length) return undefined;
        return { mime_type: image.mime, total_bytes: image.bytes, offset, data_base64: bytes.toString('base64') };
      } finally { closeSync(fd); }
    } catch { return undefined; }
  }
}
