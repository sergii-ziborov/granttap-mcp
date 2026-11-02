import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { configDir, writePrivateFile } from '../config';
import { openQuestionId } from './observations';

const Record = z.object({ requestId: z.string(), sessionId: z.string(), callId: z.string(),
  question: z.string().max(10_000), options: z.array(z.string().max(512)).max(8), createdAt: z.number(),
  room: z.string(), sourcePath: z.string().min(1).max(4096).optional(),
  announced: z.boolean().optional(), answered: z.boolean().optional(), resolvedSent: z.boolean().optional() });
export type OpenQuestionRecord = z.infer<typeof Record>;
const NAME = /^claude-open-question-[a-f0-9]{32}$/;
const directory = () => join(configDir(), 'claude-open-question-records');
const observations = new Map<string, { revision: string; record: OpenQuestionRecord }>();

function revision(path: string): string {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile() || stat.size > 32_768n) throw Error('Invalid open question record');
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

export function readOpenQuestion(requestId: string): OpenQuestionRecord | undefined {
  if (!NAME.test(requestId)) return undefined;
  const path = join(directory(), requestId + '.json');
  try {
    const before = revision(path), cached = observations.get(path);
    if (cached?.revision === before) return structuredClone(cached.record);
    const record = Record.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (record.requestId !== requestId || openQuestionId(record.sessionId, record.callId) !== requestId
      || revision(path) !== before) { observations.delete(path); return undefined; }
    if (observations.size >= 512) observations.delete(observations.keys().next().value!);
    observations.set(path, { revision: before, record });
    return structuredClone(record);
  } catch { observations.delete(path); return undefined; }
}

export function saveOpenQuestion(record: OpenQuestionRecord): void {
  if (!NAME.test(record.requestId)) throw new Error('Invalid open question identity');
  const path = join(directory(), record.requestId + '.json');
  writePrivateFile(path, JSON.stringify(record));
  observations.delete(path);
}

/** A resolved record past its retention has nothing left to tell any phone. */
export function forgetOpenQuestion(requestId: string): void {
  if (!NAME.test(requestId)) return;
  const path = join(directory(), requestId + '.json');
  rmSync(path, { force: true });
  observations.delete(path);
}

export function storedOpenQuestions(): OpenQuestionRecord[] {
  if (!existsSync(directory())) return [];
  return readdirSync(directory()).filter(name => name.endsWith('.json') && NAME.test(name.slice(0, -5)))
    .slice(-300).flatMap(name => {
      const record = readOpenQuestion(name.slice(0, -5));
      return record ? [record] : [];
    });
}
