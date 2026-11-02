import { createHash } from 'node:crypto';
import { z } from 'zod';
import { safeParse, ts } from '../sessions/support/common';

/** Written by the hook when the phone window passes; its tool result marks a question handed to the phone. */
export const DEFERRED_QUESTION_REASON = 'The person is away from this computer. GrantTap keeps this question open '
  + 'on their phone, and their answer will arrive as their next message. Stop here: end your turn and ask the '
  + 'same question in your final message, so it can also be answered at the computer.';

const WrapUp = z.object({ ask: z.string().trim().min(1).max(2_000),
  actions: z.array(z.object({ label: z.string().trim().max(512).optional(), action: z.string().optional() }))
    .max(4).optional() });
const Ask = z.object({ questions: z.array(z.object({ question: z.string().trim().min(1).max(2_000),
  options: z.array(z.object({ label: z.string().trim().min(1).max(512) })).max(8).optional() })).min(1).max(4) });

export type OpenQuestion = { requestId: string; sessionId: string; callId: string;
  question: string; options: string[]; createdAt: number };

export function openQuestionId(sessionId: string, callId: string): string {
  return 'claude-open-question-' + createHash('sha256').update(JSON.stringify([sessionId, callId]))
    .digest('hex').slice(0, 32);
}

/**
 * The question a Claude chat stopped on: the desktop app's end-of-turn ask, or an
 * AskUserQuestion the hook handed to the phone. Any later message from the person
 * (typed, a desktop button, a phone reply) closes it.
 */
export function openQuestionObservation(sessionId: string, lines: string[]) {
  let open: OpenQuestion | undefined;
  let lastHumanAt = 0;
  const asks = new Map<string, OpenQuestion>();
  for (const line of lines) {
    if (!mayMatter(line)) continue;
    const row = safeParse(line);
    if (!row || row.isSidechain === true || row.isMeta === true) continue;
    const content = row.message?.content;
    const at = ts(row.timestamp);
    if (row.type === 'assistant' && Array.isArray(content) && at) {
      for (const block of content) {
        if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue;
        const found = toolQuestion(sessionId, block, at);
        if (found && block.name === 'AskUserQuestion') asks.set(block.id, found);
        else if (found) open = found;
      }
    } else if (row.type === 'user' && (typeof content === 'string'
      || Array.isArray(content) && content.some((block: any) => block?.type !== 'tool_result'))) {
      open = undefined;
      lastHumanAt = Math.max(lastHumanAt, at || Date.now());
    } else if (row.type === 'user' && Array.isArray(content)) {
      for (const block of content) {
        const ask = asks.get(block?.tool_use_id);
        if (ask && resultText(block.content).includes(DEFERRED_QUESTION_REASON)) open = ask;
      }
    }
  }
  return { open, lastHumanAt };
}

/** Closed once the person spoke after it or a newer question replaced it. */
export function openQuestionClosed(question: Pick<OpenQuestion, 'requestId' | 'createdAt'>,
  observed: ReturnType<typeof openQuestionObservation>): boolean {
  if (observed.open?.requestId === question.requestId) return false;
  return question.createdAt <= observed.lastHumanAt
    || !!observed.open && question.createdAt <= observed.open.createdAt;
}

function toolQuestion(sessionId: string, block: any, createdAt: number): OpenQuestion | undefined {
  const base = { requestId: openQuestionId(sessionId, block.id), sessionId, callId: block.id, createdAt };
  if (block.name === 'mcp__ccd_turn__wrap_up') {
    const input = WrapUp.safeParse(block.input);
    if (!input.success) return undefined;
    // App actions (commit, merge…) run in the desktop app; only reply buttons become phone choices.
    const options = [...new Set((input.data.actions ?? []).filter(a => !a.action && a.label).map(a => a.label!))];
    return { ...base, question: input.data.ask, options };
  }
  if (block.name !== 'AskUserQuestion') return undefined;
  const input = Ask.safeParse(block.input);
  if (!input.success) return undefined;
  const [only] = input.data.questions;
  if (input.data.questions.length === 1 && only) {
    return { ...base, question: only.question, options: [...new Set((only.options ?? []).map(o => o.label))] };
  }
  const question = input.data.questions.map(q => [q.question, ...(q.options ?? []).map(o => '  - ' + o.label)]
    .join('\n')).join('\n\n');
  return { ...base, question, options: [] };
}

/** Large tool results and request records are skipped before parsing; quotes inside text are escaped. */
function mayMatter(line: string): boolean {
  if (line.includes('"type":"tool_result"')) return line.includes(DEFERRED_QUESTION_REASON);
  if (line.includes('"type":"assistant"')) {
    return line.includes('"mcp__ccd_turn__wrap_up"') || line.includes('"AskUserQuestion"');
  }
  return line.includes('"type":"user"');
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('\n')
    : '';
}
