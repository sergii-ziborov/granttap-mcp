import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { configDir, writePrivateFile } from '../config';
import { questionId } from './observations';

const Record = z.object({ requestId: z.string(), sessionId: z.string(), callId: z.string(),
  index: z.number().int().min(0).max(3), question: z.string().max(2_000),
  options: z.array(z.string().max(512)).max(8), createdAt: z.number(), room: z.string(),
  sourcePath: z.string().min(1).max(4096).optional(),
  announced: z.boolean().optional(), answered: z.boolean().optional(), resolvedSent: z.boolean().optional() });
export type QuestionRecord = z.infer<typeof Record>;
const directory = () => join(configDir(), 'codex-question-records');
const observations = new Map<string, { revision: string; record: QuestionRecord }>();

function revision(path: string): string {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile() || stat.size > 16_384n) throw Error('Invalid native question record');
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

export function readQuestion(requestId: string): QuestionRecord | undefined {
  if (!/^codex-question-[a-f0-9]{32}$/.test(requestId)) return undefined;
  const path = join(directory(), requestId + '.json');
  try {
    const before = revision(path), cached = observations.get(path);
    if (cached?.revision === before) return structuredClone(cached.record);
    const record = Record.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (record.requestId !== requestId || questionId(record.sessionId, record.callId, record.index) !== requestId
      || revision(path) !== before) { observations.delete(path); return undefined; }
    observations.delete(path);
    if (observations.size >= 512) observations.delete(observations.keys().next().value!);
    observations.set(path, { revision: before, record });
    return structuredClone(record);
  } catch { observations.delete(path); return undefined; }
}

export function saveQuestion(record: QuestionRecord): void {
  if (!/^codex-question-[a-f0-9]{32}$/.test(record.requestId)) throw new Error('Invalid native question identity');
  const path = join(directory(), record.requestId + '.json');
  writePrivateFile(path, JSON.stringify(record));
  observations.delete(path);
}

export function storedQuestions(): QuestionRecord[] {
  if (!existsSync(directory())) return [];
  return readdirSync(directory()).filter(name => /^codex-question-[a-f0-9]{32}\.json$/.test(name))
    .slice(-300).flatMap(name => {
      const record = readQuestion(name.slice(0, -5));
      return record ? [record] : [];
    });
}
