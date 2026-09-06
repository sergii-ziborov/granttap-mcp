/**
 * Attachments that arrived ahead of their message.
 *
 * A photo is most of a message's bytes and all of its wait on a slow link:
 * the phone sends it as soon as it is picked, sealed like everything else,
 * and the message that follows names it instead of carrying it. Each one is
 * kept on disk under its id, for the message or for two hours, whichever
 * comes first, and read exactly once.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UserAttachment, UserAttachmentUpload } from "../../../packages/protocol/schema";
import { configDir } from "./config";

export const ATTACHMENT_TTL_MS = 2 * 60 * 60_000;
/** How many attachments may wait for their messages at once, and how much disk they may take. */
export const MAX_STAGED_ATTACHMENTS = 32;
export const MAX_STAGED_BYTES = 48 * 1_024 * 1_024;

function directory(): string {
  const dir = join(configDir(), "attachments");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function safeId(attachmentId: string): string | undefined {
  const id = attachmentId.trim();
  return /^[A-Za-z0-9_-]{1,180}$/.test(id) ? id : undefined;
}

/**
 * Keep one attachment for the message that names it; drop the stale ones.
 * The pairing room it came through is kept with it, so a message from
 * another pairing cannot name it.
 */
export function storeAttachment(upload: UserAttachmentUpload, room?: string, now = Date.now()): boolean {
  const id = safeId(upload.attachmentId);
  if (!id) return false;
  const dir = directory();
  pruneAttachments(now, dir);
  const record = {
    name: upload.name, mimeType: upload.mimeType, data: upload.data, receivedAt: now,
    ...(room ? { room } : {}),
  };
  const body = JSON.stringify(record);
  // The staging area is bounded. One attachment too large for it is refused
  // (the message that names it is rejected and the phone sends it inline);
  // otherwise the oldest waiting ones make room, since a message that never
  // came is the likeliest reason they are still here.
  if (body.length > MAX_STAGED_BYTES) return false;
  makeRoom(dir, body.length, id);
  writeFileSync(join(dir, `${id}.json`), body, { mode: 0o600 });
  return true;
}

function makeRoom(dir: string, incoming: number, incomingId: string): void {
  let staged: Array<{ path: string; size: number; mtimeMs: number }> = [];
  try {
    staged = readdirSync(dir)
      .filter((name) => name.endsWith(".json") && name !== `${incomingId}.json`)
      .flatMap((name) => {
        try {
          const stat = statSync(join(dir, name));
          return [{ path: join(dir, name), size: stat.size, mtimeMs: stat.mtimeMs }];
        } catch {
          return [];
        }
      })
      .sort((left, right) => left.mtimeMs - right.mtimeMs);
  } catch {
    return;
  }
  let count = staged.length;
  let bytes = staged.reduce((total, item) => total + item.size, 0);
  for (const item of staged) {
    if (count < MAX_STAGED_ATTACHMENTS && bytes + incoming <= MAX_STAGED_BYTES) break;
    rmSync(item.path, { force: true });
    count -= 1;
    bytes -= item.size;
  }
}

/** The attachment the message named, taken off disk; nothing when it never came. */
export function takeAttachment(attachmentId: string, room?: string, now = Date.now()): UserAttachment | undefined {
  const id = safeId(attachmentId);
  if (!id) return undefined;
  const path = join(directory(), `${id}.json`);
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as {
      name?: unknown; mimeType?: unknown; data?: unknown; receivedAt?: unknown; room?: unknown;
    };
    // Another pairing's attachment is left where it is, for its own message.
    if (typeof record.room === "string" && room != null && record.room !== room) return undefined;
    rmSync(path, { force: true });
    if (typeof record.receivedAt === "number" && now - record.receivedAt > ATTACHMENT_TTL_MS) return undefined;
    if (typeof record.name !== "string" || typeof record.mimeType !== "string" || typeof record.data !== "string") {
      return undefined;
    }
    return { name: record.name, mimeType: record.mimeType, data: record.data };
  } catch {
    return undefined;
  }
}

export function pruneAttachments(now = Date.now(), dir = directory()): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > ATTACHMENT_TTL_MS) {
        rmSync(path, { force: true });
        removed += 1;
      }
    } catch {
      // Gone already.
    }
  }
  return removed;
}
