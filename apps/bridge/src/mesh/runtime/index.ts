import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { RelayClient } from "../../../../../packages/core/relay-client";
import type {
  MeshEvent,
  MeshHandoffPrepare,
  MeshProvider,
  MeshSnapshot,
  ProjectCapabilityRequestSet,
  SessionInfo,
  TaskCapsule,
} from "../../../../../packages/protocol/schema";
import {
  projectBackbone, projectRepositoryGraphs, waitForProjectBindingSync,
} from "../../engine/runtime/engine-projects";
import { projectCortexIntegration } from "../../cortex/integration";
import { configDir } from "../../config";
import {
  createClaudeSession,
  createCodexSession,
  createCursorSession,
  createGrokSession,
  deliverToSession,
} from "../../reply";
import { isProviderEnabled } from "../../config/runtime";
import { scanSessionHistory, scanSessions } from "../../sessions";
import { sendMeshPayload } from "../../host/session-keys";
import { linkSessionsToProjects, workingTreeState } from "../catalog";
import { catalogFromSessions } from "../catalog/models";
import { projectMcpServers } from "../catalog/project/capabilities";
import { saveProjectCapabilityRequest } from "../catalog/project/requests";
import { computerId } from "../identity/computer";
import { createCheckpoint } from "../admin/checkpoint";
import { buildTaskCapsule } from "../admin/capsule";
import { handoffReadiness } from "../tasks/readiness";
import { createHandoffFlow } from "./handoff";
import type { MeshRuntimeDependencies } from "./dependencies";
import { localMeshStore } from "../local-remote/local";
import { createHandoffWorktree, repositoryHasCommit } from "./worktree";
import { fetchRevision, pushBranch } from "../local-remote/remote";
import { projectSessionCapabilityInventory, projectExecutionCapabilitySessions } from "./capabilities";

export type { MeshRuntimeDependencies };

/** Who handed the payload in: the relay (the phone, another computer) or an agent's tool call. */
export type MeshPayloadOrigin = "relay" | "agent";

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
  capabilityInventory: projectSessionCapabilityInventory,
  computer: () => computerId(),
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
  push: pushBranch,
  fetch: fetchRevision,
  send: (client, payload, options) => sendMeshPayload(client, payload, "phone", options),
  worktree: (repository, taskId, provider, revision) => createHandoffWorktree({
    repository,
    worktreeRoot: join(configDir(), "worktrees"),
    taskId,
    provider,
    baseSha: revision,
  }),
};

async function prepareHandoff(
  deps: MeshRuntimeDependencies,
  flow: ReturnType<typeof createHandoffFlow>,
  client: RelayClient,
  request: MeshHandoffPrepare,
  catalog: (sessions: SessionInfo[]) => SessionInfo[],
): Promise<boolean> {
  const { blockHandoff, acceptHandoff } = flow;
  const sessions = catalog(deps.sessions());
  const session = sessions.find((item) => item.sessionId === request.sessionId);
  if (!session || session.projectId !== request.projectId || session.taskId !== request.taskId) {
    return false;
  }
  const cwd = session.worktree ?? session.cwd;
  const made = request.checkpoint && cwd && workingTreeState(cwd) === "dirty"
    ? createCheckpoint(cwd, request.taskId, session.title ?? request.taskId, request.createdAt)
    : undefined;
  const shared = made && cwd
    ? sessions.some((other) =>
      other.sessionId !== session.sessionId
      && other.taskId != null && other.taskId !== request.taskId
      && (other.worktree ?? other.cwd) === cwd)
    : false;
  const checkpoint = made && shared ? { ...made, status: "requires_review" as const } : made;
  const capsule = buildTaskCapsule(deps.store(), session, request, deps.computer(), checkpoint);
  const readiness = handoffReadiness({
    capsule,
    targetProviderEnabled: request.targetProvider === "grok_bot"
      || deps.providerEnabled(request.targetProvider),
    conflicts: (capsule?.resourceClaims ?? []).flatMap((resource) =>
      deps.store().conflicts(request.projectId, request.sessionId, resource, {
        repositoryId: capsule?.repository, endpointId: deps.computer(), worktree: cwd,
      }, true)),
    moduleOverlaps: (capsule?.resourceClaims ?? []).flatMap((resource) =>
      deps.store().moduleOverlaps(request.projectId, request.sessionId, resource, {
        repositoryId: capsule?.repository, endpointId: deps.computer(), worktree: cwd,
      })),
  });
  if (!readiness.ready) {
    await blockHandoff(client, request, readiness.blockedReason ?? "Handoff is not ready.");
    return false;
  }
  if (!capsule) return false;
  const local = request.targetComputer === deps.computer();
  if (request.push && !local && cwd) {
    const pushed = deps.push(cwd, capsule.branch);
    if (!pushed.ok) {
      await blockHandoff(client, request, pushed.error);
      return false;
    }
  }
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
  if (local) await acceptHandoff(client, event);
  return true;
}

export function createMeshRuntime(deps: MeshRuntimeDependencies) {
  const flow = createHandoffFlow(deps);
  const { capsulePrompt, acceptHandoff, answerAgentQuestion } = flow;
  const catalog = (sessions: SessionInfo[]) =>
    linkSessionsToProjects(deps.store(), sessions, deps.computer());

  return {
    catalog,
    snapshots(): MeshSnapshot[] {
      const store = deps.store();
      const sessions = deps.sessions();
      const models = catalogFromSessions(deps.computer(), sessions);
      return store.projectIds().flatMap((projectId) => {
        const snapshot = store.snapshot(projectId);
        if (!snapshot) return [];
        const executionIds = new Set(snapshot.executions.map((item) => item.sessionId));
        const linked = projectExecutionCapabilitySessions(
          snapshot, sessions, deps.computer(), deps.capabilityInventory,
        );
        const mcpServers = projectMcpServers(linked, projectId, executionIds);
        return [{
          ...snapshot,
          mcpServers: mcpServers.length > 0 ? mcpServers : undefined,
          modelCatalog: models.models.length > 0 || models.reason ? [models] : undefined,
        }];
      });
    },
    requestCapability(input: ProjectCapabilityRequestSet): boolean {
      const project = deps.store().snapshot(input.projectId)?.project;
      if (!project || input.sessionId !== input.projectId) return false;
      saveProjectCapabilityRequest(input);
      return true;
    },
    async handle(
      client: RelayClient,
      payload: MeshEvent | MeshSnapshot,
      origin: MeshPayloadOrigin = "relay",
    ): Promise<boolean> {
      const store = deps.store();
      if (payload.type === "mesh.snapshot") {
        store.mergeSnapshot(payload);
        return true;
      }
      const fresh = store.acceptEvent(payload);
      if (!fresh) return true;
      if (payload.eventType === "HANDOFF_REQUEST" && origin === "relay") await acceptHandoff(client, payload);
      if (payload.eventType === "AGENT_QUESTION") await answerAgentQuestion(client, payload);
      return true;
    },
    prepare(client: RelayClient, request: MeshHandoffPrepare): Promise<boolean> {
      return prepareHandoff(deps, flow, client, request, catalog);
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

export function requestProjectCapability(input: ProjectCapabilityRequestSet): boolean {
  return defaultRuntime.requestCapability(input);
}

export async function meshSnapshotsWithEngine(): Promise<MeshSnapshot[]> {
  return Promise.all(meshSnapshots().map(async (snapshot) => {
    await waitForProjectBindingSync(snapshot.projectId);
    const [backbone, repositoryGraphs] = await Promise.all([
      projectBackbone(snapshot.projectId),
      projectRepositoryGraphs(snapshot.projectId, snapshot.bindings ?? [], {
        background: true,
        priority: snapshot.tasks.reduce((latest, task) => Math.max(latest, task.updatedAt), 0),
      }),
    ]);
    const enriched = { ...snapshot, backbone, repositoryGraphs };
    const cortex = await projectCortexIntegration(enriched);
    return {
      ...enriched,
      cortex: [cortex],
    };
  }));
}

/** A person's explicit Graph refresh bypasses background job backoff. */
type GraphAnalysisDependencies = {
  snapshots: typeof meshSnapshots;
  wait: typeof waitForProjectBindingSync;
  backbone: typeof projectBackbone;
  graphs: typeof projectRepositoryGraphs;
  send: (client: RelayClient, snapshot: MeshSnapshot) => Promise<void>;
};

const graphAnalysisDependencies: GraphAnalysisDependencies = {
  snapshots: meshSnapshots,
  wait: waitForProjectBindingSync,
  backbone: projectBackbone,
  graphs: projectRepositoryGraphs,
  send: (client, snapshot) => sendMeshPayload(client, snapshot, "phone", {
    ttlMs: 60_000, reliable: true,
  }),
};

export async function analyzeProjectGraphNow(
  client: RelayClient, projectId: string,
  dependencies: GraphAnalysisDependencies = graphAnalysisDependencies,
): Promise<boolean> {
  const snapshot = dependencies.snapshots().find((item) => item.projectId === projectId);
  if (!snapshot) return false;
  await dependencies.wait(projectId);
  const current = dependencies.snapshots().find((item) => item.projectId === projectId);
  if (!current) return false;
  const [backbone, repositoryGraphs] = await Promise.all([
    dependencies.backbone(projectId),
    dependencies.graphs(projectId, current.bindings ?? [], { background: false }),
  ]);
  const reports = repositoryGraphs.length > 0 ? repositoryGraphs : [{
    projectId, repositoryId: current.project.canonicalRepositoryId,
    revision: "unverified", weavatrixVersion: "unknown",
    analysisStatus: "UNAVAILABLE" as const, analysisErrorCode: "REPOSITORY_NOT_BOUND",
    nodes: [], relations: [], totalNodes: 0, totalRelations: 0, truncated: false,
  }];
  await dependencies.send(client, {
    ...current, backbone, repositoryGraphs: reports, generatedAt: Date.now(),
  });
  return true;
}

export function handleMeshPayload(
  client: RelayClient,
  payload: MeshEvent | MeshSnapshot,
  origin: MeshPayloadOrigin = "relay",
): Promise<boolean> {
  return defaultRuntime.handle(client, payload, origin);
}

export function prepareMeshHandoff(
  client: RelayClient,
  request: MeshHandoffPrepare,
): Promise<boolean> {
  return defaultRuntime.prepare(client, request);
}
