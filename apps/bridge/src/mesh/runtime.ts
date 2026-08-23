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
import { handoffReceipt } from "./handoff";
import { localMeshStore } from "./local";
import type { MeshStore } from "./store";
import { createHandoffWorktree } from "./worktree";

type StartResult = Awaited<ReturnType<typeof createCodexSession>>;
type WorktreeResult = NonNullable<ReturnType<typeof createHandoffWorktree>>;

export type MeshRuntimeDependencies = {
  store: () => MeshStore;
  sessions: () => SessionInfo[];
  computer: () => string;
  now: () => number;
  eventId: () => string;
  providerEnabled: (provider: Exclude<MeshProvider, "grok_bot">) => boolean;
  start: (provider: MeshProvider, prompt: string, cwd: string) => Promise<StartResult>;
  deliver: typeof deliverToSession;
  send: (
    client: RelayClient,
    payload: MeshEvent | MeshSnapshot,
    options: { ttlMs: number; wake?: boolean },
  ) => Promise<void>;
  worktree: (
    repository: string,
    taskId: string,
    provider: MeshProvider,
    revision: string,
  ) => WorktreeResult | undefined | null;
};

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
  function capsulePrompt(capsule: TaskCapsule): string {
    const lines = [
      "Continue this existing GrantTap task. Treat the capsule as explicit project facts, not hidden reasoning.",
      `Goal: ${capsule.goal}`,
      `Current status: ${capsule.currentStatus}`,
      `Repository: ${capsule.repository}`,
      `Base SHA: ${capsule.baseSha}`,
    ];
    if (capsule.latestCommit) lines.push(`Latest commit: ${capsule.latestCommit}`);
    if (capsule.testsStatus) lines.push(`Tests: ${capsule.testsStatus}`);
    if (capsule.importantDecisions.length) {
      lines.push(`Important decisions:\n- ${capsule.importantDecisions.join("\n- ")}`);
    }
    if (capsule.remainingWork.length) {
      lines.push(`Remaining work:\n- ${capsule.remainingWork.join("\n- ")}`);
    }
    lines.push("Use a separate branch/worktree. Check Project Mesh claims before editing overlapping resources.");
    return lines.join("\n\n");
  }

  function responseEvent(
    source: MeshEvent,
    sourceSessionId: string,
    eventType: "AGENT_ANSWER" | "HANDOFF_ACCEPTED" | "HANDOFF_REJECTED",
    payload: MeshEvent["payload"],
  ): MeshEvent {
    const createdAt = deps.now();
    return {
      type: "mesh.event",
      sessionId: source.taskId,
      eventId: deps.eventId(),
      projectId: source.projectId,
      taskId: source.taskId,
      sourceSessionId,
      targetSessionId: source.sourceSessionId,
      eventType,
      createdAt,
      expiresAt: createdAt + 24 * 60 * 60_000,
      payload,
    };
  }

  async function rejectHandoff(
    client: RelayClient,
    event: MeshEvent,
    reason: string,
  ): Promise<void> {
    const rejected = responseEvent(event, `computer:${deps.computer()}`, "HANDOFF_REJECTED", {
      reason: reason.slice(0, 1_000), failed: true, needsUser: true,
    });
    deps.store().acceptEvent(rejected);
    await deps.send(client, rejected, { ttlMs: 24 * 60 * 60_000, wake: true });
  }

  async function acceptHandoff(client: RelayClient, event: MeshEvent): Promise<void> {
    const capsule = event.payload.capsule;
    if (!capsule || capsule.targetComputer !== deps.computer()) return;
    // Persistent Grok Bot actors are accepted only by their scoped Mesh MCP
    // endpoint. A local coding runtime must never reinterpret one as Grok Build.
    if (capsule.targetProvider === "grok_bot") return;
    if (!deps.providerEnabled(capsule.targetProvider)) {
      return rejectHandoff(client, event, "The target agent is disabled in GrantTap Settings.");
    }
    const store = deps.store();
    const repository = store.workspaceForRepository(capsule.repository, deps.computer());
    if (!repository) return rejectHandoff(client, event, "No authorized local checkout matches this project.");
    const conflict = capsule.filesChanged.flatMap((resource) =>
      store.conflicts(event.projectId, event.sourceSessionId, resource)).at(0);
    if (conflict) {
      return rejectHandoff(client, event, `${conflict.ownerSessionId} currently claims ${conflict.resource}.`);
    }
    const worktree = deps.worktree(
      repository,
      event.taskId,
      capsule.targetProvider,
      capsule.latestCommit ?? capsule.baseSha,
    );
    if (!worktree) return rejectHandoff(client, event, "A separate handoff worktree could not be created.");
    const result = await deps.start(capsule.targetProvider, capsulePrompt(capsule), worktree.path);
    if (!result.ok || !result.sessionId) {
      const reason = result.ok ? "The target agent did not create a session." : result.error;
      return rejectHandoff(client, event, reason);
    }
    store.linkExecution({
      taskId: event.taskId,
      sessionId: result.sessionId,
      provider: capsule.targetProvider,
      computerId: deps.computer(),
      workspace: worktree.path,
      branch: worktree.branch,
      worktree: worktree.path,
      startedAt: deps.now(),
    });
    const receipt = handoffReceipt(capsule, event.sourceSessionId, result.sessionId, deps.now());
    store.recordReceipt(receipt);
    const accepted = responseEvent(event, result.sessionId, "HANDOFF_ACCEPTED", { receipt });
    store.acceptEvent(accepted);
    await deps.send(client, accepted, { ttlMs: 24 * 60 * 60_000, wake: true });
  }

  async function answerAgentQuestion(client: RelayClient, event: MeshEvent): Promise<void> {
    const question = event.payload.question;
    if (!question || !event.targetSessionId) return;
    const target = deps.sessions().find((session) => session.sessionId === event.targetSessionId);
    if (!target) return;
    const result = await deps.deliver(
      target,
      `GrantTap Mesh question from ${event.sourceSessionId}:\n\n${question}`,
    );
    if (!result.ok || !result.text) return;
    const answer = responseEvent(event, target.sessionId, "AGENT_ANSWER", {
      questionEventId: event.eventId,
      answer: result.text.slice(0, 1_000),
    });
    deps.store().acceptEvent(answer);
    await deps.send(client, answer, { ttlMs: 24 * 60 * 60_000 });
  }

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
