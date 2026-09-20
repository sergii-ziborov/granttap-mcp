import type { ChildThreadInfo, SessionInfo } from "../../../../../../packages/protocol/schema";
import { aggregateChildThreads, childTitle } from "../../support/child-threads";
import { rememberCapabilityObservation, type CapabilityObservation } from "../../telemetry";
import { TOKEN_WINDOW_MS, type Scan } from "../../support/common";
import {
  codexActivitySourcesBySession,
  codexAggregatedObservationsBySession,
  codexLogPathBySession,
  type CodexActivitySource,
  type CodexCandidate,
} from "./shared";

function rootFor(candidate: CodexCandidate, byId: Map<string, CodexCandidate>): string | undefined {
  let current = candidate;
  const visited = new Set<string>([candidate.session.sessionId]);
  while (current.child) {
    const parentId = current.child.parentThreadId;
    if (visited.has(parentId)) return undefined;
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) {
      return current.child.depth === 1 ? parentId : undefined;
    }
    current = parent;
  }
  return current.session.sessionId;
}

function collectCodexRoots(candidates: CodexCandidate[]): {
  roots: CodexCandidate[];
  childrenByRoot: Map<string, CodexCandidate[]>;
} {
  const byId = new Map(candidates.map((candidate) => [candidate.session.sessionId, candidate]));
  const childrenByRoot = new Map<string, CodexCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.child) continue;
    const rootId = rootFor(candidate, byId);
    if (!rootId) continue;
    const children = childrenByRoot.get(rootId) ?? [];
    children.push(candidate);
    childrenByRoot.set(rootId, children);
  }
  const roots = candidates.filter((candidate) => !candidate.child);
  const rootIds = new Set(roots.map((candidate) => candidate.session.sessionId));
  for (const [rootId, children] of childrenByRoot) {
    if (rootIds.has(rootId) || children.length === 0) continue;
    const latest = children.reduce((a, b) =>
      b.session.lastActivityAt >= a.session.lastActivityAt ? b : a
    );
    roots.push({
      file: "",
      session: {
        sessionId: rootId,
        agent: "codex",
        title:
          latest.session.title ??
          childTitle(latest.child?.agentPath?.split("/").filter(Boolean).at(-1)) ??
          "Agent conversation",
        cwd: latest.session.cwd,
        branch: latest.session.branch,
        model: latest.session.model,
        summary: latest.session.summary,
        accessLevel: latest.session.accessLevel,
        state: "idle",
        startedAt: latest.session.startedAt,
        lastActivityAt: 0,
        tokensSession: 0,
        tokensLastTurn: 0,
        contextTokensUsed: latest.session.contextTokensUsed,
        contextWindow: latest.session.contextWindow,
      },
      observations: [],
    });
    rootIds.add(rootId);
  }
  return { roots, childrenByRoot };
}

function activitySourcesFor(
  rootCandidate: CodexCandidate,
  descendants: CodexCandidate[],
  childById: Map<string, ChildThreadInfo>,
): CodexActivitySource[] {
  const activitySources: CodexActivitySource[] = [];
  if (rootCandidate.file) {
    activitySources.push({ path: rootCandidate.file });
    codexLogPathBySession.set(rootCandidate.session.sessionId, rootCandidate.file);
  }
  for (const candidate of descendants) {
    activitySources.push({
      path: candidate.file,
      child:
        childById.get(candidate.session.sessionId) ?? {
          threadId: candidate.session.sessionId,
          parentThreadId: candidate.child!.parentThreadId,
          title: candidate.session.title,
          agentName: candidate.child!.agentName,
          depth: candidate.child!.depth,
          state: candidate.session.state,
          startedAt: candidate.session.startedAt,
          lastActivityAt: candidate.session.lastActivityAt,
          tokensSession: candidate.session.tokensSession,
          tokensLastTurn: candidate.session.tokensLastTurn,
        },
    });
  }
  activitySources.sort((a, b) => {
    const aa = a.child?.startedAt ?? rootCandidate.session.startedAt;
    const bb = b.child?.startedAt ?? rootCandidate.session.startedAt;
    return aa - bb;
  });
  return activitySources;
}

export function assembleCodexScan(candidates: CodexCandidate[]): Scan {
  const { roots, childrenByRoot } = collectCodexRoots(candidates);
  let tokensRecent = 0;
  const sessions: SessionInfo[] = [];
  for (const rootCandidate of roots) {
    const rootId = rootCandidate.session.sessionId;
    const descendants = childrenByRoot.get(rootId) ?? [];
    const childThreads: ChildThreadInfo[] = descendants.map((candidate) => ({
      threadId: candidate.session.sessionId,
      parentThreadId: candidate.child!.parentThreadId,
      title:
        candidate.session.title ??
        childTitle(candidate.child!.agentPath?.split("/").filter(Boolean).at(-1)),
      agentName: childTitle(candidate.child!.agentName),
      depth: candidate.child!.depth,
      state: candidate.session.state,
      startedAt: candidate.session.startedAt,
      lastActivityAt: candidate.session.lastActivityAt,
      tokensSession: candidate.session.tokensSession,
      tokensLastTurn: candidate.session.tokensLastTurn,
    }));
    const session = aggregateChildThreads(rootCandidate.session, childThreads);
    const childById = new Map(session.childThreads?.map((child) => [child.threadId, child]));
    const activitySources = activitySourcesFor(rootCandidate, descendants, childById);
    codexActivitySourcesBySession.set(rootId, activitySources);
    const observations: CapabilityObservation[] = [];
    for (const candidate of [rootCandidate, ...descendants]) {
      for (const observation of candidate.observations) {
        rememberCapabilityObservation(observations, { ...observation, sessionId: rootId });
      }
    }
    codexAggregatedObservationsBySession.set(rootId, observations);
    if (Date.now() - session.lastActivityAt <= TOKEN_WINDOW_MS) {
      tokensRecent += session.tokensSession;
    }
    sessions.push(session);
  }
  return { sessions, tokensRecent };
}
