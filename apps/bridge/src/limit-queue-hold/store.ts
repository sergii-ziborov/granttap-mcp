import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { configDir, writePrivateFile } from '../config';

const Time = z.number().int().nonnegative();
const DAY_MS = 86_400_000;
/** A chat not looked at for this long has nothing queued for it any more. */
const FORGET_AFTER_MS = 8 * DAY_MS;
const MAX_CHATS = 512;

const Chat = z.object({
  /** When a queued message last went to the chat while its limit showed: a refusal newer than this is a new one. */
  triedAt: Time.optional(),
  /** The hold the monitor log announced, until it announces its end. */
  held: z.object({ reason: z.enum(['reset', 'continuation', 'refused-again', 'unknown-reset']), since: Time }).strict().optional(),
  seenAt: Time,
}).strict();
export type HeldChat = z.infer<typeof Chat>;

const State = z.object({ chats: z.record(z.string().min(1).max(180), Chat) }).strict();
export type LimitQueueState = z.infer<typeof State>;

const path = () => join(configDir(), 'limit-queue-hold.json');

/**
 * What this computer decided for the queues limits hold, kept across monitor restarts and updates. A missing
 * or unreadable file is empty; a disk that cannot be read throws, so a writer never replaces it unseen.
 */
export function readLimitQueueState(): LimitQueueState {
  let raw: string;
  try { raw = readFileSync(path(), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { chats: {} };
    throw error;
  }
  try { return State.parse(JSON.parse(raw)); } catch { return { chats: {} }; }
}

export function writeLimitQueueState(state: LimitQueueState, now: number): void {
  const kept = Object.entries(state.chats).filter(([, chat]) => now - chat.seenAt < FORGET_AFTER_MS)
    .sort(([, a], [, b]) => a.seenAt - b.seenAt).slice(-MAX_CHATS);
  writePrivateFile(path(), JSON.stringify(State.parse({ chats: Object.fromEntries(kept) })));
}
