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
import { captureTransferContext, localTransferContinuations, localTaskTransfers } from "../../task-transfer";
import { configDir } from "../../config";
import {
  createClaudeSession,
  createCodexSession,
  createCursorSession,
  createGrokSession,
  deliverToSession,
} from "../../reply";
import { isProviderEnabled } from "../../config/runtime";
import { sendMeshPayload } from "../../host/session-keys";
import { inspectRepository, linkSessionsToProjects, workingTreeState } from "../catalog";
import { catalogFromEndpoint } from "../catalog/models";
import { saveProjectCapabilityRequest } from "../catalog/project/requests";
import { computerId } from "../identity/computer";
import { createCheckpoint } from "../admin/checkpoint";
import { buildTaskCapsule } from "../admin/capsule";
import { handoffReadiness } from "../tasks/readiness";
import { createHandoffFlow } from "./handoff";
import type { MeshRuntimeDependencies } from "./dependencies";
import { localMeshStore } from "../local-remote/local";
import { composeMeshSnapshot } from "./snapshot/compose";
import { enrichMeshSnapshot } from "./snapshot/enriched";
import { createHandoffWorktree, repositoryHasCommit } from "./worktree";
import { fetchRevision, pushBranch } from "../local-remote/remote";
import { projectSessionCapabilityInventory } from "./capabilities";
import { createMeshSessionCatalog } from "./catalog/session-catalog";
import { capturePreparedHandoff, preparedHandoffMetadata } from './prepared-transfer';

export type { MeshRuntimeDependencies };

/** Who handed the payload in: the relay (the phone, another computer) or an agent's tool call. */
export type MeshPayloadOrigin = "relay" | "agent";

const sessionCatalog = createMeshSessionCatalog();

export function invalidateMeshSessionHistory(): void {
  sessionCatalog.invalidateHistory();
}

const defaultDependencies: MeshRuntimeDependencies = {
  store: localMeshStore,
  sessions: sessionCatalog.sessions,
  capabilityInventory: projectSessionCapabilityInventory,
  computer: () => computerId(),
  now: Date.now,
  eventId: randomUUID,
  providerEnabled: isProviderEnabled,
  sourceCaptureCurrent: (session, capsule) => {
    const cwd = session.worktree ?? session.cwd;
    try { return Boolean(cwd && workingTreeState(cwd) === 'clean'
      && inspectRepository(cwd).revision === (capsule.latestCommit ?? capsule.baseSha)); }
    catch { return false; }
  },
  dispatchPreparedTransfer: async (event, session, confirm) =>
    (await import('../../task-network/runtime')).submitNetworkTransfer(event, session, confirm),
  start: async (provider, prompt, cwd, model) => {
    if (provider === "claude") return createClaudeSession(prompt, cwd, 240_000, [], model);
    if (provider === "codex") return createCodexSession(prompt, cwd, 240_000, [], model);
    if (provider === "cursor") return createCursorSession(prompt, cwd, 240_000, [], model);
    return createGrokSession(prompt, cwd, 240_000, [], model);
  },
  deliver: deliverToSession,
  hasCommit: repositoryHasCommit,
  push: pushBranch,
  fetch: fetchRevision,
  send: (client, payload, options) => sendMeshPayload(client, payload, "phone", options),
  worktree: (repository, taskId, provider, revision, operationId) => createHandoffWorktree({
    repository,
    worktreeRoot: join(configDir(), "worktrees"),
    taskId,
    provider,
    baseSha: revision,
    operationId,
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
  if (request.prepareOnly && session.state === "working") {
    await blockHandoff(client, request, "Pause or finish the current turn before transferring this Task.");
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
  let capsule = buildTaskCapsule(deps.store(), session, request, deps.computer(), checkpoint);
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
  let transferContext: string | undefined;
  let confirmContext: (() => Promise<boolean>) | undefined;
  if (request.prepareOnly) {
    try {
      const captured = await capturePreparedHandoff(deps, session, capsule);
      transferContext = captured.transferContext;
      capsule = captured.capsule;
      confirmContext = captured.confirm;
    } catch (error) {
      await blockHandoff(client, request, error instanceof Error ? error.message : "The complete transfer context is unavailable.");
      return false;
    }
  }
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
    payload: { capsule, transferContext },
  };
  if (request.prepareOnly && !local && deps.dispatchPreparedTransfer) {
    try {
      if (await deps.dispatchPreparedTransfer(event, session, confirmContext!)) {
        await deps.send(client, preparedHandoffMetadata(event), { ttlMs: 60 * 60_000, wake: true }).catch(() => {});
        return true;
      }
      await blockHandoff(client, request, 'Project computer transfer is not configured for this destination. Connect its Project in GrantTap.');
    } catch (error) {
      await blockHandoff(client, request, error instanceof Error ? error.message : 'The transfer could not be saved.');
    }
    return false;
  }
  deps.store().acceptEvent(event);
  await deps.send(client, request.prepareOnly ? preparedHandoffMetadata(event) : event, { ttlMs: 60 * 60_000, wake: true });
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
    snapshot(projectId: string, sessions?: SessionInfo[]): MeshSnapshot | undefined {
      return composeMeshSnapshot(deps, projectId, deps.store(), sessions ?? deps.sessions());
    },
    snapshots(): MeshSnapshot[] {
      const store = deps.store();
      const sessions = deps.sessions();
      const models = catalogFromEndpoint(deps.computer(), sessions);
      return store.projectIds().flatMap((projectId) =>
        composeMeshSnapshot(deps, projectId, store, sessions, models) ?? []);
    },
    async snapshotsAsync(sessions = deps.sessions()): Promise<MeshSnapshot[]> {
      const store = deps.store();
      const models = catalogFromEndpoint(deps.computer(), sessions);
      const snapshots: MeshSnapshot[] = [];
      for (const id of store.projectIds()) {
        await new Promise<void>(resolve => setImmediate(resolve));
        const snapshot = composeMeshSnapshot(deps, id, store, sessions, models);
        if (snapshot) snapshots.push(snapshot);
      }
      return snapshots;
    },
    requestCapability(input: ProjectCapabilityRequestSet): boolean {
      const project = deps.store().snapshot(input.projectId)?.project;
      const age = deps.now() - input.requestedAt;
      if (!project || input.sessionId !== input.projectId
        || age > 24 * 60 * 60_000 || age < -5 * 60_000) return false;
      try {
        saveProjectCapabilityRequest(input);
        return true;
      } catch {
        return false;
      }
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
      if (payload.eventType === "HANDOFF_REQUEST" && origin === "relay"
        && (fresh || payload.payload.capsule?.launch === "on_message")) await acceptHandoff(client, payload);
      if (!fresh) return true;
      if (payload.eventType === "HANDOFF_ACCEPTED" && payload.payload.receipt?.prepared) {
        const receipt = payload.payload.receipt;
        const request = store.eventsForProject(payload.projectId).find(event =>
          event.eventType === "HANDOFF_REQUEST" && event.sourceSessionId === receipt.sourceSessionId
          && event.payload.capsule?.sourceComputer === deps.computer());
        if (request) (deps.continuations ?? localTransferContinuations)().record({
          sourceSessionId: receipt.sourceSessionId, targetSessionId: receipt.targetSessionId,
          projectId: payload.projectId, taskId: receipt.taskId, capsuleHash: receipt.capsuleHash,
          acceptedAt: receipt.acceptedAt, queuedAt: request.createdAt,
        }, (deps.transfers ?? localTaskTransfers)().nativeSession({ sessionId: receipt.sourceSessionId } as SessionInfo).sessionId);
      }
      if (payload.eventType === "AGENT_QUESTION") await answerAgentQuestion(client, payload);
      return true;
    },
    prepare(client: RelayClient, request: MeshHandoffPrepare): Promise<boolean> {
      return prepareHandoff(deps, flow, client, request, catalog);
    },
    capsulePrompt,
  };
}

/** Local adapters may replace a scoped transport without rebuilding runtime dependencies. */
export function createLocalMeshRuntime(overrides: Partial<MeshRuntimeDependencies> = {}) {
  return createMeshRuntime({ ...defaultDependencies, ...overrides });
}

const defaultRuntime = createLocalMeshRuntime();

export function meshCatalog(sessions: SessionInfo[]): SessionInfo[] {
  return defaultRuntime.catalog(sessions);
}

export function meshSnapshots(): MeshSnapshot[] {
  return defaultRuntime.snapshots();
}

/** Yield between Project projections so live decisions and heartbeats continue. */
export function meshSnapshotsAsync(sessions?: SessionInfo[]): Promise<MeshSnapshot[]> {
  return defaultRuntime.snapshotsAsync(sessions);
}

export function meshSnapshot(projectId: string, sessions?: SessionInfo[]): MeshSnapshot | undefined {
  return defaultRuntime.snapshot(projectId, sessions);
}

export function requestProjectCapability(input: ProjectCapabilityRequestSet): boolean {
  return defaultRuntime.requestCapability(input);
}

export async function meshSnapshotsWithEngine(snapshots = meshSnapshots()): Promise<MeshSnapshot[]> {
  return Promise.all(snapshots.map((snapshot) => enrichMeshSnapshot(snapshot)));
}

export async function meshSnapshotWithEngine(projectId: string): Promise<MeshSnapshot | undefined> {
  const snapshot = meshSnapshot(projectId);
  return snapshot ? enrichMeshSnapshot(snapshot) : undefined;
}

export { analyzeProjectGraphNow } from "./graph/analysis";

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
