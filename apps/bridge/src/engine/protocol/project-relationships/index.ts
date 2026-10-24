import { z } from "zod";
import { EngineProtocolError } from "../transport/protocol-base";

const text = z.string().min(1).max(512).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const location = z.object({
  repository_id: text,
  path: text.refine(value => !/^(?:[A-Za-z]:|[\\/])/.test(value)
    && !value.split(/[\\/]/).includes("..")),
  line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
const schema = z.object({
  project_id: text.max(128),
  weavatrix_version: text.max(64),
  analysis_status: z.enum(["COMPLETE", "INCOMPLETE"]),
  repositories: z.array(z.object({ repository_id: text, revision: text }).strict()).min(2).max(8),
  matches: z.array(z.object({
    source: text,
    target: text,
    transport: z.enum(["http", "graphql", "grpc", "event"]),
    relation: z.literal("contract_match"),
    evidence_count: z.number().int().positive().max(1_000_000),
    evidence: z.array(location).min(1).max(16),
  }).strict()).max(128),
  truncated: z.boolean(),
}).strict().superRefine((value, context) => {
  const ids = new Set(value.repositories.map(item => item.repository_id));
  if (ids.size !== value.repositories.length || value.matches.some(edge =>
    edge.source === edge.target || !ids.has(edge.source) || !ids.has(edge.target)
    || edge.evidence_count < edge.evidence.length
    || edge.evidence.some(item => item.repository_id !== edge.source))) {
    context.addIssue({ code: "custom", message: "relationship scope is invalid" });
  }
});

export type EngineProjectRelationships = z.infer<typeof schema>;

export function parseProjectRelationships(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 65_536 || !schema.safeParse(value).success) {
    throw new EngineProtocolError("Project relationship evidence is invalid");
  }
}
