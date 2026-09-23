import type { ProjectKnowledgeRecord } from "../../../../../packages/protocol/schema";

/** Supersession is monotone across stale Mesh snapshots; only a same-scope record can hide another. */
export function activeProjectKnowledge(
  projectId: string, records: ProjectKnowledgeRecord[],
): ProjectKnowledgeRecord[] {
  const scoped = records.filter((item) => item.projectId === projectId
    && item.visibility === "project");
  const byId = new Map(scoped.map((item) => [item.recordId, item]));
  const superseded = new Set(scoped.flatMap((item) => {
    const previous = item.supersedesRecordId && byId.get(item.supersedesRecordId);
    return previous && previous.category === item.category
      && previous.repositoryId === item.repositoryId ? [previous.recordId] : [];
  }));
  return scoped.filter((item) => !superseded.has(item.recordId));
}
