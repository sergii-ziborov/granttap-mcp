import { z } from "zod";
import { Identifier } from "../endpoint";

/** A person's explicit statement, never inferred from a chat title. */
export const KnowledgeWrite = z.object({
  type: z.literal("knowledge.write"),
  projectId: Identifier,
  taskId: Identifier,
  recordId: Identifier,
  content: z.string().trim().min(1).max(4_096),
  repositoryId: z.string().trim().min(1).max(512).optional(),
  supersedesRecordId: Identifier.optional(),
  createdAt: z.number().int().nonnegative(),
}).strict().refine((request) => request.recordId !== request.supersedesRecordId,
  "a decision cannot supersede itself");
export type KnowledgeWrite = z.infer<typeof KnowledgeWrite>;

export const KnowledgeWriteResult = z.object({
  type: z.literal("knowledge.write.result"),
  projectId: Identifier,
  taskId: Identifier,
  recordId: Identifier,
  status: z.enum(["recorded", "rejected"]),
  reason: z.string().max(200).optional(),
  createdAt: z.number().int().nonnegative(),
}).strict();
export type KnowledgeWriteResult = z.infer<typeof KnowledgeWriteResult>;
