import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { openQuestionObservation } from './observations';

/** An ended turn's question and the rows after it fit well inside this tail. */
const TAIL_BYTES = 1024 * 1024;
type Cached = { revision: string; observation: ReturnType<typeof openQuestionObservation> };
const sources = new Map<string, Cached>();

/** Read only the tail of a discovered transcript; an unchanged chat costs one stat. */
export function observedOpenQuestion(sessionId: string, path: string) {
  const stat = statSync(path);
  const key = JSON.stringify([sessionId, path]);
  const revision = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  const cached = sources.get(key);
  if (cached?.revision === revision) return cached.observation;
  const observation = openQuestionObservation(sessionId, tailLines(path, stat.size));
  // Sized for the full history list, so a quiet chat is read once, not every pass.
  sources.delete(key);
  if (sources.size >= 512) sources.delete(sources.keys().next().value!);
  sources.set(key, { revision, observation });
  return observation;
}

function tailLines(path: string, size: number): string[] {
  const start = Math.max(0, size - TAIL_BYTES);
  const buffer = Buffer.allocUnsafe(size - start);
  const fd = openSync(path, 'r');
  let read = 0;
  try { read = readSync(fd, buffer, 0, buffer.length, start); } finally { closeSync(fd); }
  const text = buffer.subarray(0, read).toString('utf8');
  // The first line of a cut tail is partial; the parser skips it as invalid JSON anyway.
  return (start > 0 ? text.slice(text.indexOf('\n') + 1) : text).split('\n');
}
