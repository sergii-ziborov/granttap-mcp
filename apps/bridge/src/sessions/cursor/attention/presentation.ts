import { z } from 'zod';

const text = z.string().trim().min(1).max(2_000);
const option = z.union([z.string().trim().min(1).max(512), z.object({ label: z.string().trim().min(1).max(512) })]);
const questions = z.object({ title: z.string().max(160).optional(), questions: z.array(z.object({
  prompt: text.optional(), question: text.optional(), options: z.array(option).max(8).optional(),
})).min(1).max(4) });

/** Only the visible question and options; native reasoning and raw tool inputs stay private. */
export function cursorQuestionText(name: unknown, input: unknown): string | undefined {
  if (typeof name !== 'string' || !['askquestion', 'ask_question', 'askuserquestion'].includes(name.toLowerCase())) return;
  const parsed = questions.safeParse(input);
  if (!parsed.success || parsed.data.questions.some(q => !q.prompt && !q.question)) return;
  const parts = parsed.data.questions.map(q => [q.prompt ?? q.question!,
    ...(q.options ?? []).map(o => '• ' + (typeof o === 'string' ? o : o.label))].join('\n'));
  return [parsed.data.title, ...parts].filter(Boolean).join('\n\n').slice(0, 16_384);
}

/** Explicit user-visible notices only, never an arbitrary diagnostic or thought block. */
export function cursorNoticeText(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') return;
  const row = item as Record<string, unknown>;
  if (row.type === 'tool_result' && row.is_error === true) {
    const content = typeof row.content === 'string' ? row.content : Array.isArray(row.content)
      ? row.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : undefined;
    return typeof content === 'string' && content.trim() ? content.trim().slice(0, 4_000) : undefined;
  }
  if (!['warning', 'error'].includes(String(row.type))) return;
  const message = typeof row.message === 'string' ? row.message
    : row.message && typeof row.message === 'object' ? (row.message as Record<string, unknown>).content : row.text;
  return typeof message === 'string' && message.trim() ? message.trim().slice(0, 4_000) : undefined;
}
