import { safeParse, ts } from "../../../support/common";
import { codexLogLines } from "../shared";

type CachedImage = { key: string; bytes: Buffer; mime: string; until: number };
let cachedImage: CachedImage | undefined;

function chunk(image: CachedImage, offset: number) {
  if (offset > image.bytes.length) return undefined;
  const end = Math.min(image.bytes.length, offset + 64 * 1_024);
  return { mime_type: image.mime, total_bytes: image.bytes.length,
    offset, data_base64: image.bytes.subarray(offset, end).toString("base64") };
}

/** Bounded chunks keep native image bytes off the transcript and socket frame. */
export function codexImageChunk(sessionId: string, entryId: string, offset: number,
  providedLines?: string[]) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 8 * 1_024 * 1_024) return undefined;
  const key = `${sessionId}:${entryId}`;
  if (!providedLines && cachedImage?.key === key && cachedImage.until > Date.now()) {
    return chunk(cachedImage, offset);
  }
  const lines = providedLines ?? codexLogLines(sessionId);
  if (!lines) return undefined;
  for (const line of lines) {
    const row = safeParse(line);
    const payload = row?.payload;
    if (row?.type !== "response_item" || payload?.type !== "message"
      || payload.role !== "user" || !Array.isArray(payload.content)) continue;
    const createdAt = ts(row.timestamp);
    for (const [blockIndex, block] of payload.content.entries()) {
      if (block?.type !== "input_image" || typeof block.image_url !== "string") continue;
      if (`${sessionId}:${createdAt}:${blockIndex}` !== entryId) continue;
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(block.image_url);
      if (!match || match[2]!.length > 11 * 1_024 * 1_024) return undefined;
      const bytes = Buffer.from(match[2]!, "base64");
      if (bytes.length > 8 * 1_024 * 1_024) return undefined;
      const image = { key, bytes, mime: match[1]!, until: Date.now() + 30_000 };
      if (!providedLines) cachedImage = image;
      return chunk(image, offset);
    }
  }
  return undefined;
}
