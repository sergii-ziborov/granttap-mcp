/**
 * Catch each picture a helper run makes while the run is alive.
 *
 * A run writes its picture into its throwaway folder, and the script that
 * started it copies the picture away and deletes the folder the moment the run
 * ends. So the folder of every live run is watched: a picture is read as soon
 * as it is written to its end, and reduced and kept from memory, so deleting
 * the folder afterwards loses nothing. Each process sample also looks again,
 * in case the watch missed a write.
 */
import { execFile } from "node:child_process";
import {
  existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync,
  type Dirent, type FSWatcher, type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import {
  hasHelperRunPicture, keepHelperRunPicture, MAX_KEPT_BYTES, pictureComplete, pictureHash, pictureMime,
  type PictureMime,
} from "./store";

const run = promisify(execFile);

const PICTURE_NAME = /\.(?:png|jpe?g|webp)$/i;
const MAX_SOURCE_BYTES = 48 * 1024 * 1024;
const MAX_ENTRIES = 200;
const SETTLE_MS = 120;
/** A picture this small is kept as it is. */
const KEEP_AS_IS_BYTES = 400 * 1024;
const LONG_EDGE = 1_600;
const SIPS = "/usr/bin/sips";

export type Reduced = { bytes: Uint8Array; mime: PictureMime };
export type Reducer = (bytes: Uint8Array, mime: PictureMime) => Promise<Reduced | undefined>;

/** The picture's own pixel size, from `sips -g`. */
export function parseSipsSize(stdout: string): { width: number; height: number } | undefined {
  const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]);
  const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * Make the copy a phone downloads: a JPEG whose long side is at most 1600
 * pixels, never enlarged. Where macOS's own converter is not available the
 * picture is kept as it is when it fits.
 */
export async function reducePicture(bytes: Uint8Array, mime: PictureMime): Promise<Reduced | undefined> {
  const asIs = bytes.length <= MAX_KEPT_BYTES ? { bytes, mime } : undefined;
  if (bytes.length <= KEEP_AS_IS_BYTES || process.platform !== "darwin" || !existsSync(SIPS)) return asIs;
  const work = mkdtempSync(join(tmpdir(), "granttap-picture-"));
  try {
    const source = join(work, `source.${mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : "webp"}`);
    const target = join(work, "reduced.jpg");
    writeFileSync(source, bytes, { mode: 0o600 });
    const size = parseSipsSize((await run(SIPS, ["-g", "pixelWidth", "-g", "pixelHeight", source],
      { encoding: "utf8", timeout: 15_000 })).stdout);
    const resize = size && Math.max(size.width, size.height) > LONG_EDGE ? ["-Z", String(LONG_EDGE)] : [];
    await run(SIPS, ["-s", "format", "jpeg", "-s", "formatOptions", "75", ...resize, source, "--out", target],
      { encoding: "utf8", timeout: 30_000 });
    const reduced = readFileSync(target);
    if (pictureMime(reduced.subarray(0, 12)) !== "image/jpeg" || !pictureComplete(reduced, "image/jpeg")
      || reduced.length > MAX_KEPT_BYTES) return asIs;
    return reduced.length < bytes.length ? { bytes: reduced, mime: "image/jpeg" } : asIs;
  } catch {
    return asIs;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

type Followed = { folder: string; watcher?: FSWatcher; timer?: NodeJS.Timeout; seen: Set<string> };

export type PictureFollowerOptions = {
  reduce?: Reducer;
  keep?: typeof keepHelperRunPicture;
  watchFolder?: (folder: string, changed: () => void) => FSWatcher | undefined;
  now?: () => number;
};

function watchFolder(folder: string, changed: () => void): FSWatcher | undefined {
  try {
    const watcher = watch(folder, { persistent: false }, changed);
    watcher.on("error", () => watcher.close());
    return watcher;
  } catch {
    return undefined;
  }
}

/** Picture files in the folder and the folders directly inside it. */
function pictureFiles(folder: string): string[] {
  const out: string[] = [];
  const visit = (directory: string, depth: number) => {
    let names: Dirent[];
    try { names = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of names.slice(0, MAX_ENTRIES)) {
      const path = join(directory, entry.name);
      if (entry.isFile() && PICTURE_NAME.test(entry.name)) out.push(path);
      else if (entry.isDirectory() && depth < 1) visit(path, depth + 1);
    }
  };
  visit(folder, 0);
  return out;
}

export function createPictureFollower(options: PictureFollowerOptions = {}) {
  const reduce = options.reduce ?? reducePicture;
  const keep = options.keep ?? keepHelperRunPicture;
  const watchOne = options.watchFolder ?? watchFolder;
  const now = options.now ?? Date.now;
  const followed = new Map<string, Followed>();
  let queue: Promise<unknown> = Promise.resolve();

  const take = (item: Followed, path: string) => {
    let stat: Stats;
    try { stat = statSync(path); } catch { return; }
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SOURCE_BYTES) return;
    const key = `${path}\0${stat.size}\0${stat.mtimeMs}`;
    if (item.seen.has(key)) return;
    let bytes: Buffer;
    try { bytes = readFileSync(path); } catch { return; }
    const mime = pictureMime(bytes.subarray(0, 12));
    // Still being written: the write that finishes it is seen again.
    if (!mime || !pictureComplete(bytes, mime)) return;
    item.seen.add(key);
    const hash = pictureHash(bytes);
    if (hasHelperRunPicture(item.folder, hash)) return;
    // Spelled as the run's folder is, so it matches the path the run's own messages give.
    const source = `${item.folder}/${relative(item.folder, path).split(sep).join("/")}`;
    const name = basename(path);
    queue = queue.then(async () => {
      const reduced = await reduce(bytes, mime);
      if (reduced) keep(item.folder, { hash, name, source, mime: reduced.mime, capturedAt: now() }, reduced.bytes);
    }).catch(() => undefined);
  };

  const scan = (item: Followed) => {
    for (const path of pictureFiles(item.folder)) take(item, path);
  };

  const stop = (item: Followed) => {
    item.watcher?.close();
    if (item.timer) clearTimeout(item.timer);
    followed.delete(item.folder);
  };

  /** Follow exactly these run folders: start on new ones, look again at each, stop on the rest. */
  const follow = (folders: readonly string[]) => {
    const live = new Set(folders);
    for (const item of [...followed.values()]) if (!live.has(item.folder)) stop(item);
    for (const folder of live) {
      let item = followed.get(folder);
      if (!item) {
        const fresh: Followed = { folder, seen: new Set() };
        fresh.watcher = watchOne(folder, () => {
          if (fresh.timer) clearTimeout(fresh.timer);
          fresh.timer = setTimeout(() => { fresh.timer = undefined; if (followed.get(folder) === fresh) scan(fresh); }, SETTLE_MS);
          fresh.timer.unref?.();
        });
        followed.set(folder, fresh);
        item = fresh;
      }
      scan(item);
    }
  };

  return {
    follow,
    /** For tests: wait until every picture read so far is kept. */
    settled: () => queue,
    following: () => [...followed.keys()],
  };
}

let follower = createPictureFollower();

/** For tests: replace how pictures are reduced and kept. */
export function resetPictureFollower(options?: PictureFollowerOptions): ReturnType<typeof createPictureFollower> {
  follower.follow([]);
  follower = createPictureFollower(options);
  return follower;
}

export function followHelperRunPictures(folders: readonly string[]): void {
  follower.follow(folders);
}
