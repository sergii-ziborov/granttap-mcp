import { z } from "zod";
import { Identifier } from "../endpoint";

/** Bounded, evidence-labelled projection of the Engine's Weavatrix Memory journal. */
export const ProjectKnowledgeRecord = z.object({
  projectId: Identifier,
  taskId: Identifier,
  recordId: Identifier,
  category: z.enum(["decision", "attempt", "result"]),
  content: z.string().trim().min(1).max(4_096),
  source: z.enum(["agent_report", "task_capsule", "observed_invocation", "user_decision"]),
  sourceRef: z.string().trim().min(1).max(256),
  visibility: z.enum(["task", "project"]),
  repositoryId: z.string().trim().min(1).max(512).optional(),
  commitSha: z.string().regex(/^[a-f0-9]{7,64}$/i).optional(),
  supersedesRecordId: Identifier.optional(),
  recordedAt: z.number().int().nonnegative(),
  streamVersion: z.number().int().nonnegative(),
}).strict();
export type ProjectKnowledgeRecord = z.infer<typeof ProjectKnowledgeRecord>;
