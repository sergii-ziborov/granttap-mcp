import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ActivityEntry, SessionInfo } from "../../../../../../packages/protocol/schema";
import { configDir, writePrivateFile } from "../../../config";

const recordSchema = z.object({ version: z.literal(1), session: SessionInfo,
  turn: z.string().min(1).max(128), owner: z.number().int().positive(),
  live: ActivityEntry.optional() });
export type ConversationRecord = z.infer<typeof recordSchema>;
const directory = () => join(configDir(), "cursor-conversations");
const key = (sessionId: string) => createHash("sha256").update(sessionId).digest("hex");
export const recordPath = (sessionId: string) => join(directory(), key(sessionId) + ".json");
export const archivePath = (sessionId: string) => join(directory(), key(sessionId) + ".jsonl");
const cache = new Map<string, { stamp: string; record: ConversationRecord }>();

export function readConversation(sessionId: string): ConversationRecord | undefined {
  const path = recordPath(sessionId);
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error("Invalid Cursor conversation record");
  const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  let stored = cache.get(path);
  if (stored?.stamp !== stamp) {
    stored = { stamp, record: recordSchema.parse(JSON.parse(readFileSync(path, "utf8"))) };
    cache.set(path, stored);
    while (cache.size > 256) cache.delete(cache.keys().next().value!);
  }
  const record = structuredClone(stored.record);
  if (record.session.sessionId !== sessionId || record.session.agent !== "cursor") throw new Error("Cursor conversation identity mismatch");
  return record;
}

export function writeConversation(record: ConversationRecord): void {
  writePrivateFile(recordPath(record.session.sessionId), JSON.stringify(recordSchema.parse(record)) + "\n");
  cache.delete(recordPath(record.session.sessionId));
}

export function appendConversationEntry(sessionId: string, entry: z.infer<typeof ActivityEntry>): void {
  const path = archivePath(sessionId);
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid Cursor conversation archive");
  }
  appendFileSync(path, JSON.stringify(ActivityEntry.parse(entry)) + "\n", { mode: 0o600 });
}

export function conversationSessions(): z.infer<typeof SessionInfo>[] {
  if (!existsSync(directory())) return [];
  const paths = readdirSync(directory()).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    .map(name => ({ path: join(directory(), name), stat: lstatSync(join(directory(), name)) }))
    .filter(item => item.stat.isFile() && !item.stat.isSymbolicLink() && item.stat.size <= 256 * 1024)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, 128);
  return paths.flatMap(({ path, stat }) => {
    try {
      const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      const metadata = cache.get(path)?.stamp === stamp ? cache.get(path)!.record
        : recordSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      if (recordPath(metadata.session.sessionId) !== path || metadata.session.agent !== "cursor") return [];
      return [readConversation(metadata.session.sessionId)!.session];
    } catch { return []; }
  });
}

export function sameConversationWorkspace(record: ConversationRecord, cwd: string): boolean {
  return resolve(record.session.cwd ?? "") === resolve(cwd);
}
