import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { configDir, writePrivateFile } from '../config';
import { questionId } from './observations';

const Record = z.object({ requestId: z.string(), sessionId: z.string(), callId: z.string(),
  index: z.number().int().min(0).max(3), question: z.string().max(2_000),
  options: z.array(z.string().max(512)).max(8), createdAt: z.number(), room: z.string(),
  announced: z.boolean().optional(), answered: z.boolean().optional(), resolvedSent: z.boolean().optional() });
export type QuestionRecord = z.infer<typeof Record>;
const directory = () => join(configDir(), 'codex-question-records');

export function readQuestion(requestId: string): QuestionRecord | undefined {
  if (!/^codex-question-[a-f0-9]{32}$/.test(requestId)) return undefined;
  try {
    const path = join(directory(), requestId + '.json');
    if (statSync(path).size > 16_384) return undefined;
    const record = Record.parse(JSON.parse(readFileSync(path, 'utf8')));
    return record.requestId === requestId && questionId(record.sessionId, record.callId, record.index) === requestId
      ? record : undefined;
  } catch { return undefined; }
}

export function saveQuestion(record: QuestionRecord): void {
  if (!/^codex-question-[a-f0-9]{32}$/.test(record.requestId)) throw new Error('Invalid native question identity');
  writePrivateFile(join(directory(), record.requestId + '.json'), JSON.stringify(record));
}

export function storedQuestions(): QuestionRecord[] {
  if (!existsSync(directory())) return [];
  return readdirSync(directory()).filter(name => /^codex-question-[a-f0-9]{32}\.json$/.test(name))
    .slice(-300).flatMap(name => {
      const record = readQuestion(name.slice(0, -5));
      return record ? [record] : [];
    });
}
