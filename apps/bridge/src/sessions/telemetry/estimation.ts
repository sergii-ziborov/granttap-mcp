import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseMcpToolName } from "./identity";

const MAX_TOKEN_ESTIMATE = 100_000;
const IMAGE_TOKEN_ESTIMATE = 1_600;

function hasImageMagic(value: string): boolean {
  const trimmed = value.trimStart();
  if (/^data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,/i.test(trimmed)) return true;
  const prefix = trimmed.slice(0, 128).replace(/\s+/g, "");
  if (prefix.length < 8 || !/^[A-Za-z0-9+/=]+$/.test(prefix)) return false;
  try {
    const bytes = Buffer.from(prefix.slice(0, 96), "base64");
    const ascii = bytes.toString("ascii");
    return (
      (bytes[0] === 0x89 && ascii.slice(1, 4) === "PNG") ||
      (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
      ascii.startsWith("GIF87a") ||
      ascii.startsWith("GIF89a") ||
      (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") ||
      ascii.startsWith("BM") ||
      (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 0x2a) ||
      (bytes[0] === 0 && bytes[1] === 0 && [1, 2].includes(bytes[2] ?? -1) && bytes[3] === 0)
    );
  } catch {
    return false;
  }
}

function structuredImageMime(record: Record<string, unknown>): boolean {
  const source = record.source && typeof record.source === "object"
    ? record.source as Record<string, unknown>
    : undefined;
  const candidates = [
    record.type, record.media_type, record.mediaType, record.mime_type, record.mimeType,
    record.content_type, record.contentType, source?.media_type, source?.mediaType,
    source?.mime_type, source?.mimeType, source?.content_type, source?.contentType, source?.type,
  ];
  return candidates.some((candidate) =>
    typeof candidate === "string" && /^image\/[a-z0-9.+-]+(?:\s*;|$)/i.test(candidate));
}

export function estimateTokens(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "string") {
    if (hasImageMagic(value)) return IMAGE_TOKEN_ESTIMATE;
    return Math.ceil(Buffer.byteLength(value, "utf8") / 4);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return Math.ceil(String(value).length / 4);
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + estimateTokens(item), 0);
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const source = record.source && typeof record.source === "object"
      ? record.source as Record<string, unknown>
      : undefined;
    const encodedImage = [record.data, record.image_url, record.imageUrl, source?.data, source?.url]
      .some((candidate) => typeof candidate === "string" && hasImageMagic(candidate));
    if (record.type === "image" || record.type === "input_image" || structuredImageMime(record) || encodedImage) {
      return IMAGE_TOKEN_ESTIMATE;
    }
    if (typeof record.text === "string" && Object.keys(record).length <= 3) {
      return estimateTokens(record.text);
    }
    try {
      return Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 4);
    } catch {
      return 0;
    }
  }
  return 0;
}

export function clampTokens(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(MAX_TOKEN_ESTIMATE, Math.round(value));
}

function inputPath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const raw = record.file_path ?? record.path ?? record.filePath ?? record.filename;
  if (typeof raw !== "string" || !raw.trim() || raw.length > 4_096) return null;
  return raw.trim();
}

export function estimateBaselineTokens(
  input: unknown,
  contextTokens: number,
  cwd?: string,
): number | undefined {
  const raw = inputPath(input);
  if (!raw || /^(?:https?|data):/i.test(raw)) return undefined;
  if (!isAbsolute(raw) && !cwd) return undefined;
  const file = isAbsolute(raw) ? raw : resolve(cwd!, raw);
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size <= 0) return undefined;
    const baseline = clampTokens(stat.size / 4);
    return baseline > contextTokens ? baseline : undefined;
  } catch {
    return undefined;
  }
}

export function supportsFileReadBaseline(toolName: string): boolean {
  const operation = (parseMcpToolName(toolName)?.tool ?? toolName).toLowerCase();
  if (/(?:^|[_-])(write|edit|patch|update|delete|remove|create|upload|move|rename)(?:$|[_-])/.test(operation)) {
    return false;
  }
  return /(?:^|[_-])(read|view|preview|search|query|find|inspect|context|fetch|get|open|load|list)(?:$|[_-])/.test(operation);
}
