import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { configDir, writePrivateFile } from '../config';

const Time = z.number().int();
/** When each chat was last continued after Claude stopped its background work, newest last. */
const State = z.object({ continued: z.record(z.string().min(1).max(256), z.array(Time).max(16)) }).strict();
type ContinuedState = z.infer<typeof State>;

const path = () => join(configDir(), 'background-continuation.json');

function read(): ContinuedState {
  try { return State.parse(JSON.parse(readFileSync(path(), 'utf8'))); }
  catch { return { continued: {} }; }
}

/** How often the chat was continued since `since`. */
export function continuedSince(sessionId: string, since: number): number {
  return (read().continued[sessionId] ?? []).filter(at => at >= since).length;
}

/** Records a continuation; times older than `keepFrom` and chats with none left are dropped. */
export function noteContinued(sessionId: string, at: number, keepFrom: number): void {
  const state = read();
  state.continued[sessionId] = [...(state.continued[sessionId] ?? []), at].slice(-16);
  const continued = Object.fromEntries(Object.entries(state.continued)
    .map(([id, times]) => [id, times.filter(time => time >= keepFrom)] as const)
    .filter(([, times]) => times.length > 0).slice(-1_024));
  writePrivateFile(path(), JSON.stringify(State.parse({ continued })));
}
