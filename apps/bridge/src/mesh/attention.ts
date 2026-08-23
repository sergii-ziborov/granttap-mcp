import type { MeshEventType } from "../../../../packages/protocol/schema";

type AttentionFacts = {
  category?: unknown;
  resolved?: unknown;
  needsUser?: unknown;
  failed?: unknown;
};

/** Only deterministic, product-approved reasons may enter the human inbox. */
export function classifyHumanAttention(type: MeshEventType, facts: AttentionFacts): boolean {
  if (type === "AGENT_QUESTION") {
    return ["product", "business", "security", "destructive"].includes(String(facts.category));
  }
  if (type === "CONFLICT") return facts.resolved !== true && facts.needsUser === true;
  if (type === "TASK_BLOCKED") return facts.needsUser === true;
  if (type === "HANDOFF_REJECTED") return facts.failed === true;
  return false;
}
