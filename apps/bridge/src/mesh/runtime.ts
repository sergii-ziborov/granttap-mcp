import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import type { RelayClient } from "../../../../packages/core/relay-client";
import type {
  MeshEvent,
  MeshHandoffPrepare,
  MeshProvider,
  MeshSnapshot,
  SessionInfo,
  TaskCapsule,
} from "../../../../packages/protocol/schema";
import { configDir } from "../config";
import {
  createClaudeSession,
  createCodexSession,
  createCursorSession,
  createGrokSession,
  deliverToSession,
} from "../reply";
import { isProviderEnabled } from "../config/runtime";
import { scanSessionHistory, scanSessions } from "../sessions";
import { sendMeshPayload } from "../session-keys";
import { linkSessionsToProjects } from "./catalog";
import { buildTaskCapsule } from "./capsule";
import { handoffReadiness } from "./readiness";
import { createHandoffFlow } from "./runtime-handoff";
import type { MeshRuntimeDependencies } from "./runtime-dependencies";
import { localMeshStore } from "./local";
import { createHandoffWorktree, repositoryHasCommit } from "./worktree";

export type { MeshRuntimeDependencies };

function discoveredSessions(): SessionInfo[] {
  const byId = new Map<string, SessionInfo>();
  for (const session of [...scanSessions().sessions, ...scanSessionHistory()]) {
    byId.set(session.sessionId, session);
  }
  return [...byId.values()];
}

const defaultDependencies: MeshRuntimeDependencies = {
  store: localMeshStore,
  sessions: discoveredSessions,
  computer: hostname,
  now: Date.now,
  eventId: randomUUID,
  providerEnabled: isProviderEnabled,
  start: async (provider, prompt, cwd) => {
    if (provider === "claude") return createClaudeSession(prompt, cwd);
    if (provider === "codex") return createCodexSession(prompt, cwd);
    if (provider === "cursor") return createCursorSession(prompt, cwd);
    return createGrokSession(prompt, cwd);
  },
  deliver: deliverToSession,
  hasCommit: repositoryHasCommit,
  send: (client, payload, options) => sendMeshPayload(client, payload, "phone", options),
  worktree: (repository, taskId, provider, revision) => createHandoffWorktree(
    repository,
    join(configDir(), "worktrees"),
    taskId,
    provider,
    revision,
  ),
};

export function createMeshRuntime(deps: MeshRuntimeDependencies) {
  const flow = createHandoffFlow(deps);
  const { capsulePrompt, blockHandoff, acceptHandoff, answerAgentQuestion } = flow;

  return {
    catalog(sessions: SessionInfo[]): SessionInfo[] {
      return linkSessionsToProjects(deps.store(), sessions, deps.computer());
    },
    snapshots(): MeshSnapshot[] {
      const store = deps.store();
      return store.projectIds().flatMap((projectId) => store.snapshot(projectId) ?? []);
    },
    async handle(client: RelayClient, payload: MeshEvent | MeshSnapshot): Promise<boolean> {
      const store = deps.store();
      if (payload.type === "mesh.snapshot") {
        store.mergeSnapshot(payload);
        return true;
      }
      const fresh = store.acceptEvent(payload);
      if (!fresh) return true;
      if (payload.eventType === "HANDOFF_REQUEST") await acceptHandoff(client, payload);
      if (payload.eventType === "AGENT_QUESTION") await answerAgentQuestion(client, payload);
      return true;
    },
    async prepare(client: RelayClient, request: MeshHandoffPrepare): Promise<boolean> {
      const sessions = this.catalog(deps.sessions());
      const session = sessions.find((item) => item.sessionId === request.sessionId);
      if (!session || session.projectId !== request.projectId || session.taskId !== request.taskId) {
        return false;
      }
      const capsule = buildTaskCapsule(deps.store(), session, request, deps.computer());
      const readiness = handoffReadiness({
        capsule,
        targetProviderEnabled: request.targetProvider === "grok_bot"
          || deps.providerEnabled(request.targetProvider),
        conflicts: (capsule?.resourceClaims ?? []).flatMap((resource) =>
          deps.store().conflicts(request.projectId, request.sessionId, resource)),
      });
      if (!readiness.ready) {
        await blockHandoff(client, request, readiness.blockedReason ?? "Handoff is not ready.");
        return false;
      }
      if (!capsule) return false;
      const createdAt = deps.now();
      const event: MeshEvent = {
        type: "mesh.event",
        sessionId: request.taskId,
        eventId: deps.eventId(),
        projectId: request.projectId,
        taskId: request.taskId,
        sourceSessionId: request.sessionId,
        eventType: "HANDOFF_REQUEST",
        createdAt,
        expiresAt: createdAt + 60 * 60_000,
        payload: { capsule },
      };
      deps.store().acceptEvent(event);
      await deps.send(client, event, { ttlMs: 60 * 60_000, wake: true });
      return true;
    },
    capsulePrompt,
  };
}

const defaultRuntime = createMeshRuntime(defaultDependencies);

export function meshCatalog(sessions: SessionInfo[]): SessionInfo[] {
  return defaultRuntime.catalog(sessions);
}

export function meshSnapshots(): MeshSnapshot[] {
  return defaultRuntime.snapshots();
}

export function handleMeshPayload(
  client: RelayClient,
  payload: MeshEvent | MeshSnapshot,
): Promise<boolean> {
  return defaultRuntime.handle(client, payload);
}

export function prepareMeshHandoff(
  client: RelayClient,
  request: MeshHandoffPrepare,
): Promise<boolean> {
  return defaultRuntime.prepare(client, request);
}
