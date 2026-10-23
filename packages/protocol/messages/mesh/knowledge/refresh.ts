import { z } from "zod";
import { Identifier } from "../endpoint";
import { MeshInvocationEvent } from "../invocations";
import { ProjectKnowledgeRecord } from "./index";

const Sequence = z.number().int().nonnegative().safe();
export const ProjectKnowledgeQuery = z.object({
  type: z.literal("mesh.knowledge.query"),
  sessionId: Identifier, projectId: Identifier, requestId: Identifier,
}).strict().refine(value => value.sessionId === value.projectId, "Project scope mismatch");
export type ProjectKnowledgeQuery = z.infer<typeof ProjectKnowledgeQuery>;

/** One bounded Project read; no architecture rebuild or per-Task fan-out. */
export const ProjectKnowledgePage = z.object({
  type: z.literal("mesh.knowledge.page"),
  sessionId: Identifier, projectId: Identifier, requestId: Identifier,
  sourceEndpointId: Identifier,
  memoryAvailability: z.enum(["ready", "unavailable"]),
  invocationAvailability: z.enum(["ready", "unavailable"]),
  knowledge: z.array(ProjectKnowledgeRecord).max(32),
  supersededKnowledgeRecordIds: z.array(Identifier).max(128),
  invocations: z.array(z.object({ sequence: Sequence, event: MeshInvocationEvent }).strict()).max(32),
  incomplete: z.boolean(), generatedAt: Sequence,
}).strict().superRefine((value, ctx) => {
  let previous = 0;
  const seenCalls = new Set<string>();
  const orderedCalls = value.invocations.every(row => {
    const valid = row.sequence > previous && !seenCalls.has(row.event.event_id);
    previous = row.sequence;
    seenCalls.add(row.event.event_id);
    return valid;
  });
  if (!orderedCalls
    || new Set(value.knowledge.map(row => row.recordId)).size !== value.knowledge.length
    || new Set(value.supersededKnowledgeRecordIds).size !== value.supersededKnowledgeRecordIds.length
    || value.sessionId !== value.projectId
    || value.knowledge.some(record => record.projectId !== value.projectId || record.visibility !== "project")
    || value.invocations.some(row => row.event.project_id !== value.projectId)
    || value.memoryAvailability === "unavailable" && value.knowledge.length > 0
    || value.invocationAvailability === "unavailable" && value.invocations.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Knowledge source or Project scope mismatch" });
  }
});
export type ProjectKnowledgePage = z.infer<typeof ProjectKnowledgePage>;
