/**
 * The pictures kept from helper runs, after the runs' folders are gone.
 *
 * Each picture a run made is kept once, reduced, under the config directory,
 * next to one index that says which run made it and where the run wrote it.
 * A picture is offered only to the chat that started its run, by an id that
 * names the run and the picture's content and never a path.
 */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFile } from "../../config/access/write-private";
import { configDir } from "../../config/runtime/paths";
import { HISTORY_RETENTION_MS } from "../../sessions/support/common";
import { helperRunLink, type HelperRunLink } from "../links";

export type PictureMime = "image/png" | "image/jpeg" | "image/webp";

export type RunPicture = {
  /** The first 24 hex of the sha256 of the picture as the run wrote it. */
  hash: string;
  /** The file name the run gave it. */
  name: string;
  /** Where the run wrote it, in the spelling the run's folder has. */
  source: string;
  mime: PictureMime;
  /** Size of the kept copy. */
  bytes: number;
  capturedAt: number;
};

type StoredRun = { folder: string; pictures: RunPicture[] };
type Index = Map<string, StoredRun>;

export const MAX_KEPT_BYTES = 8 * 1024 * 1024;
const MAX_PICTURES_PER_RUN = 12;
const MAX_RUNS = 600;
const MAX_TOTAL_BYTES = 400 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const HASH = /^[a-f0-9]{24}$/;
const IMAGE_ID = /^helper-image:([a-f0-9]{24}):([a-f0-9]{24})$/;
const EXTENSION: Record<PictureMime, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export function picturesDirectory(): string {
  return join(configDir(), "helper-run-pictures");
}

function indexPath(): string {
  return join(picturesDirectory(), "index.json");
}

export function runKey(folder: string): string {
  return createHash("sha256").update(folder).digest("hex").slice(0, 24);
}

export function pictureHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 24);
}

function keptFile(key: string, picture: Pick<RunPicture, "hash" | "mime">): string {
  return join(picturesDirectory(), `${key}-${picture.hash}.${EXTENSION[picture.mime]}`);
}

export function helperRunImageId(folder: string, hash: string): string {
  return `helper-image:${runKey(folder)}:${hash}`;
}

export function isHelperRunImageId(id: string): boolean {
  return id.startsWith("helper-image:");
}

/** The format the first bytes announce. */
export function pictureMime(header: Uint8Array): PictureMime | undefined {
  const bytes = Buffer.from(header.buffer, header.byteOffset, header.byteLength);
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/** Whether a picture has been written to its end; a run's file is read while it may still be growing. */
export function pictureComplete(bytes: Uint8Array, mime: PictureMime): boolean {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === "image/png") {
    return data.length > 20 && data.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]));
  }
  if (mime === "image/jpeg") {
    const tail = data.subarray(-32);
    for (let index = tail.length - 2; index >= 0; index--) if (tail[index] === 255 && tail[index + 1] === 217) return true;
    return false;
  }
  return data.length >= 12 && data.readUInt32LE(4) + 8 === data.length;
}

function validPicture(value: unknown): RunPicture | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.hash !== "string" || !HASH.test(item.hash)) return undefined;
  if (typeof item.name !== "string" || !item.name || item.name.length > 256) return undefined;
  if (typeof item.source !== "string" || !item.source || item.source.length > 2_048) return undefined;
  if (item.mime !== "image/png" && item.mime !== "image/jpeg" && item.mime !== "image/webp") return undefined;
  if (typeof item.bytes !== "number" || !Number.isSafeInteger(item.bytes) || item.bytes <= 0
    || item.bytes > MAX_KEPT_BYTES) return undefined;
  if (typeof item.capturedAt !== "number" || !Number.isFinite(item.capturedAt)) return undefined;
  return { hash: item.hash, name: item.name, source: item.source, mime: item.mime,
    bytes: item.bytes, capturedAt: item.capturedAt };
}

function parseIndex(text: string): Index {
  const index: Index = new Map();
  const stored = JSON.parse(text) as { runs?: unknown };
  for (const value of Array.isArray(stored.runs) ? stored.runs : []) {
    if (!value || typeof value !== "object") continue;
    const run = value as Record<string, unknown>;
    if (typeof run.folder !== "string" || !run.folder || run.folder.length > 1_024) continue;
    const pictures = (Array.isArray(run.pictures) ? run.pictures : []).map(validPicture)
      .filter((item): item is RunPicture => item !== undefined).slice(0, MAX_PICTURES_PER_RUN);
    if (pictures.length > 0) index.set(runKey(run.folder), { folder: run.folder, pictures });
  }
  return index;
}

let cached: { path: string; stamp: string; index: Index } | undefined;

function readIndex(): Index {
  const path = indexPath();
  let stamp: string;
  try {
    const stat = statSync(path);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return new Map();
  }
  if (cached?.path === path && cached.stamp === stamp) return cached.index;
  let index: Index = new Map();
  try { index = parseIndex(readFileSync(path, "utf8")); } catch { /* An unreadable index keeps nothing; the next picture rewrites it. */ }
  cached = { path, stamp, index };
  return index;
}

/** The pictures kept from the run in this folder, oldest first. */
export function helperRunPictures(folder: string | undefined): RunPicture[] {
  return folder ? readIndex().get(runKey(folder))?.pictures ?? [] : [];
}

export function hasHelperRunPicture(folder: string, hash: string): boolean {
  return helperRunPictures(folder).some((picture) => picture.hash === hash);
}

/** Drop runs older than history, then the oldest, until the store is within its bounds. */
function bounded(index: Index, now: number): { kept: Index; dropped: string[] } {
  const runs = [...index.entries()].sort((left, right) =>
    Math.max(...left[1].pictures.map((item) => item.capturedAt))
      - Math.max(...right[1].pictures.map((item) => item.capturedAt)));
  const dropped: string[] = [];
  let total = runs.reduce((sum, [, run]) => sum + run.pictures.reduce((inner, item) => inner + item.bytes, 0), 0);
  while (runs.length > 0) {
    const [key, run] = runs[0]!;
    const newest = Math.max(...run.pictures.map((item) => item.capturedAt));
    if (newest >= now - HISTORY_RETENTION_MS && runs.length <= MAX_RUNS && total <= MAX_TOTAL_BYTES) break;
    runs.shift();
    for (const picture of run.pictures) {
      total -= picture.bytes;
      dropped.push(keptFile(key, picture));
    }
  }
  return { kept: new Map(runs), dropped };
}

/** Keep one reduced picture from the run in this folder. Returns whether it was new. */
export function keepHelperRunPicture(folder: string, picture: Omit<RunPicture, "bytes">,
  bytes: Uint8Array, now = Date.now()): boolean {
  if (!HASH.test(picture.hash) || bytes.length === 0 || bytes.length > MAX_KEPT_BYTES) return false;
  if (pictureMime(bytes.subarray(0, 12)) !== picture.mime) return false;
  let index: Index = new Map();
  try { index = parseIndex(readFileSync(indexPath(), "utf8")); } catch { /* Nothing kept yet. */ }
  const key = runKey(folder);
  const run = index.get(key) ?? { folder, pictures: [] };
  if (run.pictures.some((item) => item.hash === picture.hash) || run.pictures.length >= MAX_PICTURES_PER_RUN) return false;
  mkdirSync(picturesDirectory(), { recursive: true, mode: 0o700 });
  const kept: RunPicture = { ...picture, bytes: bytes.length };
  writePrivateFile(keptFile(key, kept), bytes);
  index.set(key, { folder, pictures: [...run.pictures, kept] });
  const { kept: stored, dropped } = bounded(index, now);
  writePrivateFile(indexPath(), JSON.stringify({ version: 1,
    runs: [...stored.values()].map((item) => ({ folder: item.folder, pictures: item.pictures })) }));
  for (const file of dropped) rmSync(file, { force: true });
  cached = undefined;
  return stored.get(key)?.pictures.some((item) => item.hash === picture.hash) === true;
}

/** Read one bounded chunk of a kept picture for the chat that started its run, and for no other. */
export function helperRunPictureChunk(chatId: string, imageId: string, offset: number,
  link: (folder: string) => HelperRunLink | undefined = helperRunLink) {
  const match = IMAGE_ID.exec(imageId);
  if (!match || !Number.isSafeInteger(offset) || offset < 0) return undefined;
  const [, key, hash] = match as unknown as [string, string, string];
  const run = readIndex().get(key);
  const picture = run?.pictures.find((item) => item.hash === hash);
  if (!run || !picture || link(run.folder)?.parentSessionId !== chatId) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(keptFile(key, picture), "r");
    const size = fstatSync(fd).size;
    if (size <= offset || size > MAX_KEPT_BYTES) return undefined;
    const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, size - offset));
    if (readSync(fd, bytes, 0, bytes.length, offset) !== bytes.length) return undefined;
    if (offset === 0 && pictureMime(bytes.subarray(0, 12)) !== picture.mime) return undefined;
    return { mime_type: picture.mime, total_bytes: size, offset, data_base64: bytes.toString("base64") };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
