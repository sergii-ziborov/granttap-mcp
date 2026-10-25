import { createHash } from 'node:crypto';
import { z } from 'zod';
import { safeParse, ts } from '../sessions/support/common';

const Questions = z.object({ questions: z.array(z.object({ title: z.string().trim().min(1).max(2_000),
  options: z.array(z.string().trim().min(1).max(512)).max(8).nullish() })).min(1).max(4) });
const Answer = z.object({ questionItemId: z.string(), answer: z.string().trim().min(1) });

export type NativeQuestion = { requestId: string; sessionId: string; callId: string; index: number;
  question: string; options: string[]; createdAt: number };

export function questionId(sessionId: string, callId: string, index: number): string {
  return 'codex-question-' + createHash('sha256').update(JSON.stringify([sessionId, callId, index]))
    .digest('hex').slice(0, 32);
}

export function nativeQuestionObservations(sessionId: string, lines: string[]) {
  const questions: NativeQuestion[] = [];
  const answered = new Set<string>();
  for (const line of lines) {
    const row = safeParse(line);
    const p = row?.payload;
    if (!p) continue;
    if (row.type === 'response_item' && p.type === 'function_call' && p.name === 'request_user_input_async'
      && typeof p.call_id === 'string' && /^[a-zA-Z0-9_-]{1,180}$/.test(p.call_id)) {
      const data = Questions.safeParse(typeof p.arguments === 'string' ? safeParse(p.arguments) : p.arguments);
      const at = ts(row.timestamp);
      if (!data.success || !at) continue;
      data.data.questions.forEach((q, index) => questions.push({ requestId: questionId(sessionId, p.call_id, index),
        sessionId, callId: p.call_id, index, question: q.title, options: q.options ?? [], createdAt: at }));
    }
    const texts = row.type === 'response_item' && p.type === 'message' && p.role === 'user'
      ? (p.content ?? []).filter((b: any) => ['input_text', 'text'].includes(b.type)).map((b: any) => b.text)
      : row.type === 'event_msg' && p.type === 'user_message' ? [p.message ?? p.text] : [];
    for (const text of texts) {
      if (typeof text !== 'string') continue;
      const envelope = /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/.exec(text.trim());
      if (!envelope) continue;
      const replies = z.array(Answer).safeParse(safeParse(envelope[1]!));
      if (!replies.success) continue;
      for (const reply of replies.data) {
        const id = z.tuple([z.literal('request_user_input_async'), z.string(), z.number().int().min(0).max(3)])
          .safeParse(safeParse(reply.questionItemId));
        if (id.success) answered.add(questionId(sessionId, id.data[1], id.data[2]));
      }
    }
  }
  return { questions, answered };
}

export function nativeAnswerEnvelope(question: NativeQuestion, answer: string): string {
  return '<send_user_message_question_reply>\n' + JSON.stringify([{
    questionItemId: JSON.stringify(['request_user_input_async', question.callId, question.index]),
    question: question.question, answer,
  }]) + '\n</send_user_message_question_reply>';
}

export function codexQuestionText(input: unknown): string | undefined {
  const parsed = Questions.safeParse(input);
  if (!parsed.success) return undefined;
  return parsed.data.questions.map(q => [q.title, ...(q.options ?? []).map(option => '• ' + option)]
    .join('\n')).join('\n\n');
}
