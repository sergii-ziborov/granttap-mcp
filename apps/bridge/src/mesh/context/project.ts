/**
 * One permitted Project/Task view, two renderers. Compact is a smaller
 * answer with expand links, not a second copy of the full view.
 */
import type { ScopedMeshView } from "../snapshot/scoped-view";
import { compileMeshContext } from "./packet";

export type ProjectContextMode = "compact" | "full" | "legacy";

export type ContextCut = {
  found: number;
  shown: number;
  truncated: boolean;
  reasons: string[];
  expand: string;
};

export type CompactContextEvent = {
  eventId: string;
  eventType: string;
  source: string;
  sourceSessionId: string;
  question?: string;
  answer?: string;
  reason?: string;
  summary?: string;
};

export type CompactProjectContext = {
  schema: "granttap.project-context.compact.v1";
  mode: "compact";
  project: { projectId: string; name: string; repositoryId?: string };
  execution: { sessionId: string; provider: string; computerId: string; taskId: string };
  task: {
    taskId: string | null;
    title: string | null;
    goal: string | null;
    state: string | null;
    ownerSessionId?: string;
  };
  repository: { repositoryId?: string; worktree?: string; owner?: string };
  peerTasks: ScopedMeshView["peerTasks"];
  events: CompactContextEvent[];
  eventsCut: ContextCut;
  decisions: CompactContextEvent[];
  claims: Array<{ resource: string; owner: string; taskId: string }>;
  claimsCut: ContextCut;
  expand: { full: string; map: string };
  budget: { counter: "events_and_claims"; unit: "items"; limit: number };
};

const COMPACT_LIMIT = 8;

function cut(found: number, shown: number, expand: string, reason: string): ContextCut {
  return {
    found,
    shown,
    truncated: found > shown,
    reasons: found > shown ? [reason] : [],
    expand,
  };
}

export function renderCompactProjectContext(
  view: ScopedMeshView,
  expand: { full: string; map: string } = {
    full: "granttap://mesh/current?mode=full",
    map: "granttap://mesh/map",
  },
): CompactProjectContext {
  const events = view.events.map((event) => ({
    eventId: event.eventId,
    eventType: event.eventType,
    source: event.sourceSessionId,
    sourceSessionId: event.sourceSessionId,
    question: event.payload.question,
    answer: event.payload.answer,
    reason: event.payload.reason,
    summary: event.payload.summary,
  }));
  const shownEvents = events.slice(-COMPACT_LIMIT);
  const decisions = events.filter((event) =>
    event.eventType === "AGENT_ANSWER" || event.eventType === "TASK_COMPLETED");
  const claims = view.claims.map((claim) => ({
    resource: claim.resource,
    owner: claim.ownerSessionId,
    taskId: claim.taskId,
  }));
  const shownClaims = claims.slice(0, COMPACT_LIMIT);
  return {
    schema: "granttap.project-context.compact.v1",
    mode: "compact",
    project: {
      projectId: view.project.projectId,
      name: view.project.name,
      repositoryId: view.project.canonicalRepositoryId,
    },
    execution: {
      sessionId: view.execution.sessionId,
      provider: view.execution.provider,
      computerId: view.execution.computerId,
      taskId: view.execution.taskId,
    },
    task: {
      taskId: view.task?.taskId ?? view.execution.taskId ?? null,
      title: view.task?.title ?? null,
      goal: view.task?.goal ?? null,
      state: view.task?.state ?? null,
      ownerSessionId: view.task?.ownerSessionId,
    },
    repository: {
      repositoryId: view.project.canonicalRepositoryId,
      worktree: view.execution.workspace,
      owner: view.execution.computerId,
    },
    peerTasks: view.peerTasks,
    events: shownEvents,
    eventsCut: cut(events.length, shownEvents.length, expand.full, "compact event window"),
    decisions: decisions.slice(-COMPACT_LIMIT),
    claims: shownClaims,
    claimsCut: cut(claims.length, shownClaims.length, expand.full, "compact claim window"),
    expand,
    budget: { counter: "events_and_claims", unit: "items", limit: COMPACT_LIMIT },
  };
}

export async function renderProjectContext(
  view: ScopedMeshView, mode: ProjectContextMode,
): Promise<unknown> {
  const contextPacket = await compileMeshContext(view);
  if (mode === "compact") return { ...renderCompactProjectContext(view), contextPacket };
  if (mode === "legacy") {
    return { schema: "granttap.mesh-scope.legacy.v2", mode: "legacy", view, contextPacket };
  }
  return { ...view, mode: "full", contextPacket };
}

export function parseProjectContextMode(value: string | undefined): ProjectContextMode {
  if (value === "full" || value === "legacy") return value;
  return "compact";
}
