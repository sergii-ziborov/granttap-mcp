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

function directory(): string {
  const dir = join(configDir(), "attachments");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function safeId(attachmentId: string): string | undefined {
  const id = attachmentId.trim();
  return /^[A-Za-z0-9_-]{1,180}$/.test(id) ? id : undefined;
}

/** Keep one attachment for the message that names it; drop the stale ones. */
export function storeAttachment(upload: UserAttachmentUpload, now = Date.now()): boolean {
  const id = safeId(upload.attachmentId);
  if (!id) return false;
  const dir = directory();
  pruneAttachments(now, dir);
  const record = { name: upload.name, mimeType: upload.mimeType, data: upload.data, receivedAt: now };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(record), { mode: 0o600 });
  return true;
}

/** The attachment the message named, taken off disk; nothing when it never came. */
export function takeAttachment(attachmentId: string, now = Date.now()): UserAttachment | undefined {
  const id = safeId(attachmentId);
  if (!id) return undefined;
  const path = join(directory(), `${id}.json`);
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as {
      name?: unknown; mimeType?: unknown; data?: unknown; receivedAt?: unknown;
    };
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
