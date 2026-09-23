import { createHash } from "node:crypto";
import type { MeshEvent, ProjectKnowledgeRecord } from "../../../../../packages/protocol/schema";

/** Supersession is monotone across stale Mesh snapshots; only a same-scope record can hide another. */
export function activeProjectKnowledge(
  projectId: string, records: ProjectKnowledgeRecord[],
): ProjectKnowledgeRecord[] {
  return activeScopedKnowledge(projectId, records);
}

/** Task-private records stay available only to their own Task. */
export function activeScopedKnowledge(
  projectId: string, records: ProjectKnowledgeRecord[], taskId?: string,
): ProjectKnowledgeRecord[] {
  const scoped = records.filter((item) => item.projectId === projectId
    && (item.visibility === "project" || item.visibility === "task" && item.taskId === taskId));
  const byId = new Map(scoped.map((item) => [item.recordId, item]));
  const superseded = new Set(scoped.flatMap((item) => {
    const previous = item.supersedesRecordId && byId.get(item.supersedesRecordId);
    return previous && previous.category === item.category
      && previous.visibility === item.visibility
      && previous.repositoryId === item.repositoryId
      && (item.visibility !== "task" || previous.taskId === item.taskId)
      ? [previous.recordId] : [];
  }));
  return scoped.filter((item) => !superseded.has(item.recordId));
}

/** Keep correction tombstones even when the old record is outside the phone's bounded page. */
export function supersededProjectKnowledgeIds(
  projectId: string, records: ProjectKnowledgeRecord[],
): string[] {
  return supersededScopedKnowledgeIds(projectId, records);
}

export function supersededScopedKnowledgeIds(
  projectId: string, records: ProjectKnowledgeRecord[], taskId?: string,
): string[] {
  return [...new Set(records.filter((item) => item.projectId === projectId
    && (item.visibility === "project" || item.visibility === "task" && item.taskId === taskId))
    .sort((left, right) => right.recordedAt - left.recordedAt)
    .flatMap((item) => item.supersedesRecordId ? [item.supersedesRecordId] : [])
    .slice(0, 128))].sort();
}

/** Keep unrelated event context, but remove decisions already recorded or corrected. */
export function unrecordedKnowledgeEvents(
  events: MeshEvent[], records: ProjectKnowledgeRecord[], supersededIds: string[] = [],
): MeshEvent[] {
  const covered = new Set([...records.map((item) => item.recordId), ...supersededIds]);
  return events.flatMap((event) => {
    const capsule = event.eventType === "HANDOFF_REQUEST" ? event.payload.capsule : undefined;
    if (capsule) {
      const importantDecisions = capsule.importantDecisions.filter((_, index) => {
        const id = `capsule-${createHash("sha256")
          .update(JSON.stringify([event.eventId, index])).digest("hex")}`;
        return !covered.has(id);
      });
      return [{ ...event, payload: { ...event.payload,
        capsule: { ...capsule, importantDecisions } } }];
    }
    return covered.has(event.eventId) ? [] : [event];
  });
}
