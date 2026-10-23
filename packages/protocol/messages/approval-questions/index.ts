import { z } from "zod";

export const ApprovalQuestion = z.object({
  question: z.string().min(1).max(2_000),
  header: z.string().max(64).default(""),
  options: z.array(z.object({ label: z.string().min(1).max(512),
    description: z.string().max(2_000).default("") })).min(1).max(8),
  multiSelect: z.boolean().default(false),
});
export const ApprovalQuestions = z.array(ApprovalQuestion).min(1).max(4)
  .refine(items => new Set(items.map(item => item.question)).size === items.length);

/** A permission tap without a complete human answer cannot satisfy a question. */
export function questionAnswers(questions: z.infer<typeof ApprovalQuestions> | undefined,
  note: string | null | undefined): Record<string, string> | undefined {
  if (!questions || !note || note.length > 20_000) return undefined;
  try {
    const answers = z.record(z.string(), z.string().trim().min(1).max(4_000)).parse(JSON.parse(note));
    if (Object.keys(answers).length !== questions.length
      || questions.some(item => !Object.hasOwn(answers, item.question))) return undefined;
    return answers;
  } catch { return undefined; }
}
