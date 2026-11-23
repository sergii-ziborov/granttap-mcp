import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AUTO_COMPACT_MAX_TOKENS, AUTO_COMPACT_MIN_TOKENS } from '../../../../packages/protocol/schema';
import { configDir, writePrivateFile } from '../config';

const Time = z.number().int().nonnegative();
const Tokens = z.number().int().nonnegative();
const ChatId = z.string().min(1).max(180);

/** One compaction this computer ran: why, its span, and what the provider said it did. */
const Run = z.object({
  by: z.enum(['phone', 'threshold']),
  startedAt: Time,
  endedAt: Time,
  ok: z.boolean(),
  preTokens: Tokens.optional(),
  postTokens: Tokens.optional(),
  /** The provider's words when it did not compact, kept short; never message text. */
  error: z.string().max(300).optional(),
}).strict();
export type CompactionRun = z.infer<typeof Run>;

const State = z.object({
  /** The threshold set for a chat from the phone; `0` is off. A chat not listed takes the default. */
  thresholds: z.record(ChatId, z.union([z.literal(0),
    z.number().int().min(AUTO_COMPACT_MIN_TOKENS).max(AUTO_COMPACT_MAX_TOKENS)])),
  /** The newest runs per chat, oldest first. */
  runs: z.record(ChatId, z.array(Run).max(8)),
  /** The context reading, by its time, an automatic compaction was last tried for; it is tried once. */
  triedReading: z.record(ChatId, Time).optional(),
}).strict();
export type CompactionState = z.infer<typeof State>;

const MAX_CHATS = 2_048;
const path = () => join(configDir(), 'context-compaction.json');
const empty = (): CompactionState => ({ thresholds: {}, runs: {} });

/**
 * The saved state; a missing file, or one that is not this state, is empty. A disk that cannot be
 * read throws, so a writer never replaces the thresholds the person set with an empty file.
 */
export function readCompactionState(): CompactionState {
  let raw: string;
  try { raw = readFileSync(path(), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty();
    throw error;
  }
  try { return State.parse(JSON.parse(raw)); } catch { return empty(); }
}

/** The state as it was, or empty when the disk cannot be read: for reading, never for writing back. */
export function savedCompactionState(): CompactionState {
  try { return readCompactionState(); } catch { return empty(); }
}

function newest<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).slice(-MAX_CHATS));
}

/** Changes the saved state in one step: nothing else in this process runs between its read and write. */
export function updateCompactionState(change: (state: CompactionState) => void): void {
  const state = readCompactionState();
  change(state);
  writePrivateFile(path(), JSON.stringify(State.parse({
    thresholds: newest(state.thresholds),
    runs: newest(Object.fromEntries(Object.entries(state.runs).map(([id, runs]) => [id, runs.slice(-8)]))),
    ...(state.triedReading ? { triedReading: newest(state.triedReading) } : {}),
  })));
}
