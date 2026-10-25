import { statSync } from 'node:fs';
import { readCodexLogWindow } from '../sessions/scan/codex';
import { nativeQuestionObservations } from './observations';

type Cached = { revision: string; observation: ReturnType<typeof nativeQuestionObservations> };
const sources = new Map<string, Cached>();

/** Read only a discovered source's bounded tail; idle conversations cost one stat. */
export function observedQuestions(sessionId: string, path: string) {
  const stat = statSync(path);
  const key = JSON.stringify([sessionId, path]);
  const revision = `${stat.mtimeMs}:${stat.size}`;
  const cached = sources.get(key);
  if (cached?.revision === revision) return cached.observation;
  const observation = nativeQuestionObservations(sessionId, readCodexLogWindow(path, 0, 2 * 1024 * 1024));
  if (sources.size >= 64) sources.clear();
  sources.set(key, { revision, observation });
  return observation;
}
