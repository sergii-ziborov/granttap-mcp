/**
 * Pictures a chat's own answer saved in its own working folder.
 *
 * A headless image run (`codex exec "… save the file, print the path"`) answers
 * with the path of the picture it saved. Its scanner passes the answer here. A
 * picture is an image file the answer names that lies inside the chat's working
 * folder (both read as real paths, so a link out of the folder does not count),
 * is a regular file, and was written since the turn began. A working folder that
 * is the file system root or the home folder holds no such pictures.
 *
 * Only the monitor keeps them, one at a time: the file is read, recognised by
 * its first bytes, reduced and kept like a helper run's picture, under the chat.
 * Catalogs and transcripts only read what was kept.
 */
import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { KeptPicture, SessionActivity, SessionInfo } from "../../../../../packages/protocol/schema";
import { pictureAttachment, samePath } from "../attach";
import { MAX_SOURCE_BYTES, reducePicture, type Reducer } from "./capture";
import {
  chatPictureImageId, chatPictureLookup, chatPictures, keepHelperRunPicture, pictureComplete, pictureHash, pictureMime,
  type PictureOwner,
} from "./store";

/** A picture as an answer names it: where it is, and the spelling the answer used. */
export type NamedPicture = { path: string; source: string };
/** What a scanner found in one chat's newest answer; never published. */
export type ChatPictureHint = PictureOwner & { cwd: string; at: number; pictures: NamedPicture[] };

const IMAGE_NAME = /\.(?:png|jpe?g|webp)$/i;
const MAX_NAMED = 12;
/** A file written this long before the turn's first row was still written by it. */
const CLOCK_SLACK_MS = 2_000;
/** Answers older than this are not looked at again for pictures. */
const RECENT_MS = 48 * 60 * 60_000;
const MAX_TRIED = 4_096;

/** Every different image path an answer spells: bare, in backticks, as a Markdown link target. */
function namedPaths(answer: string): string[] {
  const out: string[] = [];
  for (const raw of answer.split(/[\s`'"<>()[\]]+/)) {
    let token = raw.replace(/^[*_]+/, "").replace(/[.,;:!?*_]+$/, "");
    if (token.startsWith("file://")) {
      try { token = decodeURIComponent(token.slice("file://".length)); } catch { continue; }
    }
    if (!token || token.length > 1_024 || !IMAGE_NAME.test(token) || /[\u0000-\u001f]/.test(token)) continue;
    if (!out.includes(token)) out.push(token);
    if (out.length >= MAX_NAMED) break;
  }
  return out;
}

/** The real path of a regular file inside the folder, and never the folder itself. */
function insideFolder(path: string, folder: string): string | undefined {
  try {
    const root = realpathSync(folder), real = realpathSync(path);
    const child = relative(root, real);
    if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) return undefined;
    return statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** A folder that is the whole disk or the whole home folder is not a chat's own working folder here. */
function ownWorkingFolder(folder: string, home: string): boolean {
  try {
    const real = realpathSync(folder);
    return real !== sep && real !== realpathSync(home);
  } catch {
    return false;
  }
}

/** The pictures an answer names that the turn saved inside its working folder. */
export function savedPictures(answer: string | undefined, cwd: string | undefined, since: number,
  home = homedir()): NamedPicture[] {
  if (!answer || !cwd || !isAbsolute(cwd) || !ownWorkingFolder(cwd, home)) return [];
  const found: NamedPicture[] = [];
  const seen = new Set<string>();
  for (const source of namedPaths(answer)) {
    const path = source.startsWith("~/") ? join(home, source.slice(2)) : isAbsolute(source) ? source : resolve(cwd, source);
    const real = insideFolder(path, cwd);
    if (!real || seen.has(real)) continue;
    try { if (statSync(real).mtimeMs < since - CLOCK_SLACK_MS) continue; } catch { continue; }
    seen.add(real);
    found.push({ path, source });
  }
  return found;
}

/** What a phone that does not read `images` sees as the chat's newest message. */
export function pictureSavedText(pictures: readonly { path: string }[], generated?: string): string | undefined {
  const names = [...new Set(pictures.map((picture) => basename(picture.path)))];
  if (names.length === 0 && generated) names.push(generated);
  if (names.length === 0) return undefined;
  return `Picture saved: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`;
}

let noted: readonly ChatPictureHint[] = [];
const tried = new Set<string>();
let queue: Promise<unknown> = Promise.resolve();

/** The newest catalog's hints, for the monitor to keep; other processes only note them. */
export function noteChatPictureHints(hints: readonly ChatPictureHint[]): void {
  noted = hints;
}

/** The first bytes alone: a file that does not start as a picture is read no further. */
function header(path: string): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(12);
    return bytes.subarray(0, readSync(fd, bytes, 0, 12, 0));
  } finally {
    closeSync(fd);
  }
}

type KeepOptions = { reduce?: Reducer; keep?: typeof keepHelperRunPicture; now?: () => number };

async function keepOne(hint: ChatPictureHint, picture: NamedPicture, options: Required<KeepOptions>): Promise<void> {
  const real = insideFolder(picture.path, hint.cwd);
  if (!real) return;
  const stat = statSync(real);
  if (stat.size === 0 || stat.size > MAX_SOURCE_BYTES || !pictureMime(header(real))) return;
  const bytes = readFileSync(real);
  const mime = pictureMime(bytes.subarray(0, 12));
  if (!mime || !pictureComplete(bytes, mime)) return;
  const owner: PictureOwner = { agent: hint.agent, sessionId: hint.sessionId };
  const hash = pictureHash(bytes);
  if (chatPictures(owner).some((item) => item.hash === hash)) return;
  const reduced = await options.reduce(bytes, mime);
  if (!reduced) return;
  options.keep(hint.cwd, { hash, name: basename(real).slice(0, 256), source: picture.source, mime: reduced.mime,
    capturedAt: options.now() }, reduced.bytes, options.now(), owner);
}

/**
 * Keep each picture the noted answers saved that is not kept yet, one at a time. A file is tried
 * once in each size and modification time it has. Resolves when this pass is done.
 */
export function keepNotedChatPictures(options: KeepOptions = {}): Promise<unknown> {
  const settings = { reduce: options.reduce ?? reducePicture, keep: options.keep ?? keepHelperRunPicture,
    now: options.now ?? Date.now };
  const now = settings.now();
  for (const hint of noted) {
    if (hint.at < now - RECENT_MS) continue;
    for (const picture of hint.pictures) {
      let key: string;
      try {
        const stat = statSync(picture.path);
        key = `${hint.agent}\0${hint.sessionId}\0${picture.path}\0${stat.size}\0${stat.mtimeMs}`;
      } catch { continue; }
      if (tried.has(key)) continue;
      if (tried.size >= MAX_TRIED) tried.clear();
      tried.add(key);
      queue = queue.then(() => keepOne(hint, picture, settings)).catch(() => undefined);
    }
  }
  return queue;
}

/** For tests: forget what was noted and tried. */
export function forgetChatPictures(): void {
  noted = [];
  tried.clear();
}

function kept(owner: PictureOwner, lookup: (owner: PictureOwner) => ReturnType<typeof chatPictures>, text = ""): KeptPicture[] {
  return lookup(owner).slice(-12).map((picture) => pictureAttachment(chatPictureImageId(owner, picture.hash), picture, text));
}

/** Each chat with the pictures kept from its own answers. */
export function attachChatPictures(sessions: SessionInfo[]): SessionInfo[] {
  const lookup = chatPictureLookup();
  return sessions.map((session) => {
    const images = kept({ agent: session.agent as PictureOwner["agent"], sessionId: session.sessionId }, lookup);
    return images.length > 0 ? { ...session, images } : session;
  });
}

/**
 * A chat's own kept pictures on the answers that name them. A page without such an answer, or an
 * agent conversation of the chat, is left as it is.
 */
export function withChatPictures(activity: SessionActivity, session: SessionInfo | undefined): SessionActivity {
  if (!session || activity.threadId || session.sessionId !== activity.sessionId) return activity;
  const owner: PictureOwner = { agent: session.agent as PictureOwner["agent"], sessionId: session.sessionId };
  const pictures = chatPictures(owner);
  if (pictures.length === 0) return activity;
  const entries = [...activity.entries];
  for (const picture of pictures) {
    const id = chatPictureImageId(owner, picture.hash);
    if (entries.some((entry) => entry.images?.some((image) => image.id === id))) continue;
    const source = samePath(picture.source);
    const at = entries.map((entry, index) => ["final", "message"].includes(entry.kind) && !entry.childThreadId
      && namedPaths(entry.text).some((token) => samePath(token) === source) ? index : -1)
      .filter((index) => index >= 0).at(-1);
    if (at === undefined) continue;
    const entry = entries[at]!;
    entries[at] = { ...entry, images: [...(entry.images ?? []), ...kept(owner, () => [picture], entry.text)].slice(0, 32) };
  }
  return { ...activity, entries };
}
