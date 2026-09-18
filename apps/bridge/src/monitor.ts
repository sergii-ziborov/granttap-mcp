import { hostname } from "node:os";
import { RelayClient } from "../../../packages/core/relay-client";
import type {
  AgentEvent,
  ConfigSet,
  HostGrant,
  SessionAccessSet,
  SessionCompact,
  SessionControl,
  SessionInfo,
  SessionMcpSet,
  SessionShellSet,
  SessionSkillSet,
  SessionSubscription,
  SessionsStatus,
  TaskCreate,
  UserAttachment,
  UserMessage,
} from "../../../packages/protocol/schema";
import { ATTACHMENT_MISSING_ERROR } from "../../../packages/protocol/schema";
import { pruneAttachments, storeAttachment, takeAttachment } from "./attachment-store";
import {
  configDir,
  loadRuntimeConfig,
  saveRuntimeConfig,
  setSessionMcpAllowed,
  setSessionPaused,
  setSessionShellAllowed,
  setSessionSkillAllowed,
} from "./config";
import { monitorLeadership } from "./monitor-leadership";
import { mcpServersForSession, workspaceSkills } from "./capabilities";
import { compactCodexSession } from "./codex-control";
import {
  createClaudeSession,
  createCodexSession,
  createCursorSession,
  createGrokSession,
  deliverToSession,
  stopDeliveries,
} from "./reply";
import { abandonDelivery, beginDelivery, completeDelivery } from "./delivery";
import { inspectAgentIntegrations } from "./install";
import { handleToolUpdate } from "./tools/update-handler";
import { noteDeliveredRun } from "./mesh/run-digest";
import { applyConfigSet, currentConfigRevision, loadConfigCommandState } from "./config-commands";
import { acceptInstanceEpoch, currentInstanceEpoch } from "./instance-epoch";
import { applyHostGrant } from "./mesh/execution-policy";
import { evaluateCreateTask } from "./mesh/create-task";
import { recordDelegation } from "./mesh/delegation-loop";
import { enqueuePinnedTask } from "./mesh/task-queue";
import { computerId } from "./mesh/computer-identity";
import { localMeshStore } from "./mesh/local";

/**
 * How long one delivery may run. A phone message can ask for real work — read
 * a photo, change code, run the tests — and four minutes cut such runs off
 * mid-way, leaving half-done edits nobody was told about.
 */
const DELIVERY_TIMEOUT_MS = 10 * 60_000;
import { refreshMcpLoad } from "./machine-load/mcp-load-refresh";
import { approvalsStatus } from "./approval-state";
import { primeSessionKeys, sendProjectPayload, sendSessionPayload } from "./session-keys";
import { sendMeshPayload } from "./session-keys";
import { handleMeshPayload, meshCatalog, meshSnapshots, prepareMeshHandoff } from "./mesh/runtime";
import { releaseClaimByPerson, releaseResult } from "./mesh/admin";
import { deriveObservedClaims } from "./mesh/observed-claims";
import { ingestRuntimeInvocations } from "./engine/invocation-ingest";
import { handleInvocationQuery } from "./engine/invocation-query";
import { cachedSessionActivity } from "./monitor-session-activity";
import { HEARTBEAT_INTERVAL_MS, publishHeartbeat } from "./monitor-heartbeat";
import { applyPairingJoin } from "./pairing";
import { recordPhoneSeen } from "./presence";
import { startPublishLoop } from "./monitor-publish-loop";
import { singleFlightPublisher } from "./monitor-single-flight";
import { createMachineLoadPublisher } from "./machine-load";
import { startMachineLoadLoop } from "./machine-load/loop";
import {
  handleProjectPolicySet,
  publishProjectPolicyStatuses,
} from "./project-policy/runtime";
import {
  scanCapabilityUsage,
  scanSessionHistory,
  scanSessions,
  scanThreadActivity,
  scopeCapabilityUsageToRoom,
  TOKEN_WINDOW_HOURS,
} from "./sessions";

/**
 * A tick rescans every provider's logs. At 5s those scans overlapped, pinned a
 * core, and starved the relay socket; liveness now rides the heartbeat instead,
 * so the catalog is free to run at a cadence the machine can actually sustain.
 */
const INTERVAL_MS = Number(
  process.env.GRANTTAP_MONITOR_INTERVAL_MS ?? process.env.NODVOX_MONITOR_INTERVAL_MS ?? 30_000,
);
const HISTORY_INTERVAL_MS = 10_000;
export const HISTORY_PUBLISH_LIMIT = Number(
  process.env.GRANTTAP_MONITOR_HISTORY_LIMIT ?? 40,
);

/**
 * Keep the catalog bounded while retaining an explicitly open history task.
 * The phone can therefore reopen an older chat without restoring the previous
 * unbounded history + capability frame.
 */
export function boundedCatalogHistory(
  sessions: SessionInfo[],
  pinnedIds: ReadonlySet<string> = new Set(),
  limit = HISTORY_PUBLISH_LIMIT,
): SessionInfo[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 40;
  if (sessions.length <= safeLimit) return sessions;
  const pinned = sessions.filter((session) => pinnedIds.has(session.sessionId)).slice(0, safeLimit);
  const pinnedSet = new Set(pinned.map((session) => session.sessionId));
  const rest = sessions
    .filter((session) => !pinnedSet.has(session.sessionId))
    .slice(0, Math.max(0, safeLimit - pinned.length));
  return [...pinned, ...rest].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

function resolveSession(sessionId: string, status?: SessionsStatus): SessionInfo | undefined {
  if (status) {
    return status.sessions.find((session) => session.sessionId === sessionId)
      ?? status.history?.find((session) => session.sessionId === sessionId);
  }
  return scanSessions().sessions.find((session) => session.sessionId === sessionId)
    ?? scanSessionHistory().find((session) => session.sessionId === sessionId);
}

/** Send one bounded transcript under the task-specific E2EE key. */
export async function publishSessionEvents(
  client: RelayClient,
  sessionId: string,
  status?: SessionsStatus,
  threadId?: string,
): Promise<boolean> {
  const session = resolveSession(sessionId, status);
  if (!session) return false;
  const activity = threadId ? scanThreadActivity(session, threadId) : cachedSessionActivity(session);
  await sendSessionPayload(client, activity, sessionId, "phone", {
    ttlMs: INTERVAL_MS * 24,
    reliable: false,
  });
  return true;
}

export type SessionMonitor = {
  publish: () => Promise<void>;
  close: () => void;
};

/**
 * Attach task discovery and phone-to-agent delivery to the same relay client
 * used by MCP tools. This keeps STDIO stdout clean and removes the old need for
 * a separate `granttap-mcp monitor` terminal process.
 */
export function startSessionMonitor(client: RelayClient): SessionMonitor {
  const subscriptions = new Set<string>();
  const leadership = monitorLeadership();
  primeSessionKeys(client);
  let historyCache: { generatedAt: number; sessions: SessionsStatus["sessions"] } | undefined;
  let lastHistoryPublishedAt = 0;
  let lastCapabilityPublishedAt = 0;
  const publishMachineLoad = createMachineLoadPublisher({
    log: (line) => process.stderr.write(`[monitor] ${line}\n`),
  });
  const loadLoop = startMachineLoadLoop({
    connected: () => client.isConnected,
    // Only the leader reports load. Every MCP server used to run this loop
    // too, each with the code of the day it started, and the phone flickered
    // between their answers.
    publish: (status, intervalMs) => (leadership.acquire()
      ? publishMachineLoad(client, status, intervalMs)
      : Promise.resolve(undefined)),
    onError: (error) => {
      process.stderr.write(
        `[monitor] load report failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    },
  });

  const decorate = (sessions: SessionsStatus["sessions"]): SessionsStatus["sessions"] => {
    const runtime = loadRuntimeConfig();
    const visible = sessions.filter((session) =>
      runtime.providerSettings[session.agent as keyof typeof runtime.providerSettings] !== false
    );
    const coordinated = runtime.meshEnabled ? meshCatalog(visible) : visible;
    return coordinated.map((session) => {
      const base: SessionInfo = {
        ...session,
        accessLevel: runtime.sessionAccess[session.sessionId] ?? session.accessLevel,
        mcpServers: mcpServersForSession(
          session,
          runtime.sessionMcpDisabled[session.sessionId] ?? [],
        ),
        shellAllowed: !runtime.sessionShellDisabled.includes(session.sessionId),
        ...(runtime.pausedSessions.includes(session.sessionId) ? { paused: true } : {}),
      };
      // Global/repository skill arrays can be large. The open task gets the
      // complete row immediately after session.subscribe; list-only rows stay lean.
      return subscriptions.has(session.sessionId)
        ? {
            ...base,
            skills: workspaceSkills(session.cwd).map((skill) => ({
              ...skill,
              allowed: !(runtime.sessionSkillsDisabled[session.sessionId] ?? []).includes(skill.name),
            })),
          }
        : base;
    });
  };

  const history = (force = false): SessionsStatus["sessions"] => {
    if (force || !historyCache || Date.now() - historyCache.generatedAt > 60_000) {
      historyCache = { generatedAt: Date.now(), sessions: scanSessionHistory() };
    }
    return historyCache.sessions;
  };

  const snapshot = (includeHistory: boolean, forceHistory = false): SessionsStatus => {
    sweepAttachments();
    // A change the store's lock held back is written on the next tick.
    if (loadRuntimeConfig().meshEnabled) localMeshStore().flush();
    const { sessions, tokensRecent } = scanSessions();
    const runtime = loadRuntimeConfig();
    return {
      type: "sessions.status",
      machine: hostname(),
      sessions: decorate(sessions),
      history: includeHistory
        ? decorate(boundedCatalogHistory(history(forceHistory), subscriptions))
        : undefined,
      tokensRecent,
      tokenWindowHours: TOKEN_WINDOW_HOURS,
      tokensAllTime: tokensRecent,
      gatingEnabled: runtime.enabled,
      excludedSessions: runtime.excludedSessions,
      // Echo the whole auto-accept state back so the iOS Settings screen shows
      // what the Mac is actually enforcing, not what it last sent.
      autoAcceptDefault: runtime.autoAcceptDefault,
      autoAcceptBySession: runtime.autoAcceptBySession,
      autoAcceptPaused: runtime.autoAcceptPaused,
      providerSettings: runtime.providerSettings,
      meshEnabled: runtime.meshEnabled,
      contextCompilerEnabled: runtime.contextCompilerEnabled,
      configRevision: currentConfigRevision(),
      instanceEpoch: currentInstanceEpoch(),
      agents: inspectAgentIntegrations(),
      generatedAt: Date.now(),
    };
  };

  const publish = singleFlightPublisher(async (forceHistory: boolean): Promise<void> => {
    if (!client.isConnected) return;
    // Any live socket must prove the machine is alive. The HTTP helper is a
    // peer and often holds the only WebSocket while the LaunchAgent holds the
    // lock — gating heartbeat on leadership made the phone mark this Mac offline.
    await publishHeartbeat(client).catch(() => {});
    if (!leadership.acquire()) return;
    const includeHistory = forceHistory || Date.now() - lastHistoryPublishedAt >= HISTORY_INTERVAL_MS;
    const status = snapshot(includeHistory, forceHistory);
    // The next tick replaces this snapshot outright, so queuing it durably only
    // delays the current one behind superseded copies.
    await client.send(status, "phone", { ttlMs: INTERVAL_MS * 24, reliable: false });
    if (includeHistory) lastHistoryPublishedAt = Date.now();
    // The load loop consumes this bounded snapshot, then samples processes on
    // its own cadence without re-running provider discovery.
    loadLoop.updateStatus(status);
    // What each MCP server costs is sampled beside it, so a finished call has
    // something honest to report instead of an empty resource row.
    void refreshMcpLoad(status.sessions).catch(() => {});

    // Project Mesh is separately encrypted under each project key. The relay
    // sees only the legacy routing envelope and ciphertext.
    if (loadRuntimeConfig().meshEnabled) {
      // What agents were seen editing becomes intent claims on their Tasks,
      // so an overlap shows while the work happens rather than at the merge.
      deriveObservedClaims(localMeshStore(), status.sessions);
      // The Engine owns full per-call history. Ingest in the background so a
      // slow or unavailable Engine cannot delay phone liveness or Mesh status.
      void ingestRuntimeInvocations(status.sessions).catch(() => {});
      const meshes = meshSnapshots();
      for (const mesh of meshes) {
        await sendMeshPayload(client, mesh, "phone", {
          ttlMs: INTERVAL_MS * 24,
          reliable: false,
        }).catch(() => {});
      }
      await publishProjectPolicyStatuses(
        client,
        meshes.map((mesh) => mesh.projectId),
      ).catch(() => {});
    }

    // Detail follows the lean catalog, before unrelated snapshots can delay it.
    for (const sessionId of subscriptions) {
      await publishSessionEvents(client, sessionId, status).catch(() => false);
    }

    await client.send(approvalsStatus(), "phone", { ttlMs: INTERVAL_MS * 3, reliable: false });
    if (Date.now() - lastCapabilityPublishedAt >= 30_000) {
      const usage = scanCapabilityUsage([
        ...status.sessions,
        ...history(false),
      ]);
      await client.send(scopeCapabilityUsageToRoom(usage, client.room), "phone", { ttlMs: 90_000, reliable: false });
      lastCapabilityPublishedAt = Date.now();
    }
  });

  const off = client.onMessage(async (payload) => {
    if (payload.type === "pairing.join") {
      const result = applyPairingJoin(payload);
      if (result === "adopted" && process.env.GRANTTAP_MONITOR_PRIMARY === "1") {
        setImmediate(() => process.exit(0));
      }
      return true;
    }
    recordPhoneSeen();
    // Codex may start one MCP server per open task. Exactly one instance owns
    // phone routing, so a single phone message can never create duplicate tasks.
    if (!leadership.acquire()) return false;
    if (payload.type === "user.message") {
      // Correlated replies belong to the MCP `ask` waiter in one process.
      if (payload.requestId) return false;
      let deliveryStarted = false;
      if (payload.messageId) {
        const state = beginDelivery(payload.messageId);
        if (state === "completed") {
          await sendDeliveryReceipt(client, payload.messageId, "accepted", undefined, payload.sessionId);
          return true;
        }
        if (state === "processing") return false;
        deliveryStarted = true;
      }
      try {
        const outcome = await handleUserMessage(client, payload);
        if (payload.messageId && deliveryStarted) {
          if (outcome === "rejected") {
            // The phone sends the message again with what was missing; the
            // ledger must let that second copy through.
            abandonDelivery(payload.messageId);
          } else {
            completeDelivery(payload.messageId);
            await sendDeliveryReceipt(client, payload.messageId, "accepted", undefined, payload.sessionId);
          }
        }
        void publish().catch(() => {});
        return true;
      } catch {
        if (payload.messageId && deliveryStarted) abandonDelivery(payload.messageId);
        return false;
      }
    } else if (payload.type === "user.attachment") {
      // Ahead of its message, so the message itself travels light.
      return storeAttachment(payload, client.room);
    } else if (payload.type === "config.set") {
      handleConfigSet(payload);
      void publish().catch(() => {});
      return true;
    } else if (payload.type === "project.task.create") {
      const state = beginDelivery(payload.operationId);
      if (state === "completed") {
        await sendDeliveryReceipt(client, payload.operationId, "accepted");
        return true;
      }
      if (state === "processing") return false;
      try {
        await handleTaskCreate(client, payload);
        completeDelivery(payload.operationId);
        await sendDeliveryReceipt(client, payload.operationId, "accepted");
        void publish().catch(() => {});
        return true;
      } catch {
        abandonDelivery(payload.operationId);
        return false;
      }
    } else if (payload.type === "project.execution.host-grant") {
      handleHostGrant(payload);
      void publish().catch(() => {});
      return true;
    } else if (payload.type === "session.subscribe") {
      // Whoever sent this is looking at the chat right now, so its transcript
      // goes first and on its own. Opening a chat for the first time used to
      // start with the catalog rescan instead — seconds of provider discovery
      // and history scanning — and the transcript only rode out at the end of
      // it, so a live chat showed "no messages loaded" for as long as that
      // took. A chat already being watched took the fast path all along.
      void publishSessionEvents(client, payload.sessionId).catch(() => false);
      // A newly opened chat still earns one catalog republish, for the complete
      // Skills catalog its row gains. A repeated heartbeat for a chat already
      // being watched changes nothing and must not rescan every provider.
      if (handleSubscription(subscriptions, payload)) {
        void publish(true).catch(() => {});
      }
      return true;
    } else if (payload.type === "session.events") {
      void publishSessionEvents(client, payload.sessionId, undefined, payload.threadId).catch(() => false);
      return true;
    } else if (payload.type === "sessions.refresh") {
      // Pull-to-refresh must include a newly scanned history snapshot; otherwise
      // a phone that cleared local state can receive an apparently empty tick.
      void publish(true).catch(() => {});
      return true;
    } else if (payload.type === "session.access.set") {
      handleAccessSet(payload);
      void publish().catch(() => {});
      return true;
    } else if (payload.type === "session.mcp.set") {
      handleMcpSet(payload);
      void publish().catch(() => {});
      return true;
    } else if (payload.type === "session.skill.set") {
      handleSkillSet(payload);
      void publish().catch(() => {});
      return true;
    } else if (payload.type === "session.shell.set") {
      handleShellSet(payload);
      void publish().catch(() => {});
      return true;
    } else if (payload.type === "session.compact") {
      await handleCompact(client, payload);
      void publish().catch(() => {});
      return true;
    } else if (payload.type === "session.control") {
      await handleSessionControl(client, payload, () => { void publish().catch(() => {}); });
      void publish().catch(() => {});
      return true;
    } else if (payload.type === "tool.update") {
      // Minutes long, so the relay loop does not wait on it: the phone sees
      // `updating` in the next status and the result when it lands.
      void handleToolUpdate(
        (result) => client.send(result, "phone", { ttlMs: 15 * 60_000 }),
        payload,
      ).catch(() => {}).finally(() => { void publish().catch(() => {}); });
      void publish().catch(() => {});
      return true;
    } else if (payload.type === "project.policy.set" && loadRuntimeConfig().meshEnabled) {
      return handleProjectPolicySet(client, payload);
    } else if (payload.type === "mesh.invocation.query" && loadRuntimeConfig().meshEnabled) {
      return handleInvocationQuery(client, payload);
    } else if ((payload.type === "mesh.event" || payload.type === "mesh.snapshot")
      && loadRuntimeConfig().meshEnabled) {
      await handleMeshPayload(client, payload);
      void publish().catch(() => {});
      return true;
    } else if (payload.type === "mesh.handoff.prepare" && loadRuntimeConfig().meshEnabled) {
      const prepared = await prepareMeshHandoff(client, payload);
      if (prepared) void publish().catch(() => {});
      return prepared;
    } else if (payload.type === "mesh.claim.release" && loadRuntimeConfig().meshEnabled) {
      // The person's own authority, not an owner's event: written down, then
      // applied, and answered either way, so a refusal is seen where it was asked.
      const outcome = releaseClaimByPerson(localMeshStore(), payload);
      await sendProjectPayload(client, releaseResult(payload, outcome), "phone", { ttlMs: 15 * 60_000 })
        .catch(() => {});
      if (outcome.released) void publish().catch(() => {});
      return true;
    }
    return false;
  });

  const stopCatalog = startPublishLoop({
    connected: () => client.isConnected,
    intervalMs: INTERVAL_MS,
    publish: () => publish().catch(() => {}),
  });
  // Liveness rides its own loop. Queueing it behind the single-flight catalog
  // would reintroduce exactly the failure it exists to prevent: a busy computer
  // going quiet long enough for the phone to call it offline and drop chats.
  const stopHeartbeat = startPublishLoop({
    connected: () => client.isConnected,
    intervalMs: HEARTBEAT_INTERVAL_MS,
    immediate: true,
    publish: () => publishHeartbeat(client).catch(() => {}),
  });

  return {
    publish: () => publish(false),
    close: () => {
      stopCatalog();
      stopHeartbeat();
      loadLoop.stop();
      off();
      subscriptions.clear();
      leadership.release();
    },
  };
}

export async function sendDeliveryReceipt(
  client: RelayClient,
  messageId: string,
  status: "accepted" | "rejected",
  error?: string,
  sessionId?: string,
): Promise<void> {
  const payload = {
    type: "delivery.receipt" as const,
    messageId,
    sessionId: sessionId?.trim() || undefined,
    status,
    error,
    receivedAt: Date.now(),
  };
  const options = { ttlMs: 24 * 60 * 60_000 };
  await (sessionId
    ? sendSessionPayload(client, payload, sessionId, "phone", options)
    : client.send(payload, "phone", options)).catch(() => {});
}

export function agentEventForUserMessage(
  message: UserMessage,
  text: string,
  sessionId?: string,
  kind: "status" | "response" = "response",
): AgentEvent {
  return {
    type: "agent.event",
    text,
    requestId: message.requestId,
    kind,
    sessionId,
    originMessageId: message.messageId,
    createdAt: Date.now(),
  };
}

function handleAccessSet(message: SessionAccessSet): void {
  const runtime = loadRuntimeConfig();
  runtime.sessionAccess[message.sessionId] = message.accessLevel;
  saveRuntimeConfig(runtime);
}

function handleMcpSet(message: SessionMcpSet): void {
  setSessionMcpAllowed(message.sessionId, message.serverName, message.allowed);
}

function handleSkillSet(message: SessionSkillSet): void {
  setSessionSkillAllowed(message.sessionId, message.skillName, message.allowed);
}

function handleShellSet(message: SessionShellSet): void {
  setSessionShellAllowed(message.sessionId, message.allowed);
}

/** What the agent is told when the person lifts the hold and asks it to go on. */
export const RESUME_PROMPT =
  "GrantTap: this chat was resumed from the phone. Continue the work you were doing before the pause; tool calls are allowed again.";

/**
 * Pause or resume one chat.
 *
 * A pause is a hold on tool calls, enforced by the provider hooks on every call
 * the chat makes, plus a stop of any delivery already running for it. The
 * result goes back at once; the continuation a resume asks for runs in the
 * background, so a phone that tapped "resume" does not wait on a whole turn.
 */
export async function handleSessionControl(
  client: RelayClient,
  message: SessionControl,
  afterContinue: () => void = () => {},
): Promise<void> {
  const sessionId = message.sessionId;
  const reply = async (ok: boolean, text: string): Promise<void> => {
    await sendSessionPayload(client, {
      type: "session.control.result",
      sessionId,
      action: message.action,
      ok,
      message: text.slice(0, 1_000),
      createdAt: Date.now(),
    }, sessionId, "phone", { ttlMs: 15 * 60_000 });
  };
  try {
    setSessionPaused(sessionId, message.action === "pause");
  } catch (error) {
    return reply(false, error instanceof Error ? error.message : String(error));
  }
  if (message.action === "pause") {
    const stopped = stopDeliveries(sessionId);
    return reply(true, stopped > 0
      ? `Paused. ${stopped} running turn stopped; every tool call from this chat is refused until you resume.`
      : "Paused: every tool call from this chat is refused until you resume.");
  }
  if (!message.continue) return reply(true, "Resumed: tool calls are allowed again.");
  const session = scanSessions().sessions.find((item) => item.sessionId === sessionId)
    ?? scanSessionHistory().find((item) => item.sessionId === sessionId);
  if (!session) {
    return reply(true, "Resumed. This chat is not on this computer any more, so nothing was asked to continue.");
  }
  await reply(true, "Resumed and asked to continue.");
  void deliverToSession(session, RESUME_PROMPT, DELIVERY_TIMEOUT_MS, [], { ignorePause: true })
    .then((result) => {
      if (!result.ok) {
        process.stderr.write(`[monitor] resume of ${sessionId.slice(0, 8)} did not continue: ${result.error}\n`);
      }
    })
    .catch(() => {})
    .finally(afterContinue);
}

async function handleCompact(client: RelayClient, message: SessionCompact): Promise<void> {
  const resultMessage = async (ok: boolean, text: string): Promise<void> => {
    const payload = {
        type: "session.compact.result",
        sessionId: message.sessionId,
        ok,
        message: text,
        createdAt: Date.now(),
      } as const;
    await sendSessionPayload(client, payload, message.sessionId, "phone", { ttlMs: 15 * 60_000 });
  };

  const session = scanSessions().sessions.find((item) => item.sessionId === message.sessionId);
  if (!session) return resultMessage(false, "This task is no longer available on the computer.");
  if (session.agent !== "codex") {
    return resultMessage(false, "Claude Code does not expose a supported remote compaction API.");
  }
  if (session.state === "working") {
    return resultMessage(false, "Wait for the active Codex turn to finish before compacting it.");
  }

  const result = await compactCodexSession(session.sessionId);
  await resultMessage(
    result.ok,
    result.ok ? "Codex context compaction completed." : `Context compaction failed: ${result.error}`,
  );
}

/**
 * Elect one monitor across all GrantTap MCP processes on this machine. The
 * lock records the owning pid and is reclaimed automatically after a crash;
 * non-leaders retry on each publish tick and on incoming relay traffic.
 */

/**
 * Report whether this actually changed what the monitor is watching.
 *
 * The phone re-sends `session.subscribe` every few seconds while a chat is
 * open. Treating each repeat as news turned one heartbeat into a full provider
 * rescan, so only a real change is worth republishing the catalog for.
 */
export { handleSubscription as handleSubscriptionForTest };

function handleSubscription(subscriptions: Set<string>, message: SessionSubscription): boolean {
  const before = subscriptions.size;
  if (message.active) subscriptions.add(message.sessionId);
  else subscriptions.delete(message.sessionId);
  return subscriptions.size !== before;
}

export function handleConfigSet(message: ConfigSet): void {
  applyConfigSet(message);
}

export function handleHostGrant(message: HostGrant): void {
  if (!acceptInstanceEpoch(message.instanceEpoch, loadConfigCommandState().requireFreshCommands)) {
    return;
  }
  applyHostGrant(message.projectId, message.grant, message.revision, computerId());
}

export async function handleTaskCreate(
  client: RelayClient,
  message: TaskCreate,
): Promise<void> {
  const say = (text: string, sessionId?: string, wake = false) => {
    const payload = {
      type: "agent.event" as const,
      text,
      sessionId,
      createdAt: Date.now(),
    };
    const options = { ttlMs: 15 * 60_000, wake: wake || undefined };
    return (sessionId
      ? sendSessionPayload(client, payload, sessionId, "phone", options)
      : client.send(payload, "phone", options)).catch(() => {});
  };
  if (!acceptInstanceEpoch(message.instanceEpoch, loadConfigCommandState().requireFreshCommands)) {
    await say("This command was issued for a previous instance of this computer.", undefined, true);
    return;
  }
  const loop = recordDelegation({
    operationId: message.operationId,
    parentSessionId: message.parentSessionId,
  });
  if (!loop.ok) {
    await say("This bot cannot create another task from a delegated task.", undefined, true);
    return;
  }
  const agent = message.agent ?? "codex";
  const displayName = {
    claude: "Claude Code", codex: "Codex", cursor: "Cursor", grok: "Grok Build",
  }[agent];
  if (!loadRuntimeConfig().providerSettings[agent]) {
    await say(`${displayName} is disabled in GrantTap Settings.`, undefined, true);
    return;
  }
  const resolved = resolveMessageAttachments(
    { attachmentRefs: message.attachmentRefs, attachments: message.attachments },
    (attachmentId) => takeAttachment(attachmentId, client.room),
  );
  if (!resolved.ok) {
    await sendDeliveryReceipt(client, message.operationId, "rejected", ATTACHMENT_MISSING_ERROR);
    return;
  }
  const admitted = evaluateCreateTask({
    cwd: message.cwd, agent, model: message.model,
    hostOnline: client.isConnected,
  });
  if (!admitted.ok) {
    await say(admitted.detail, undefined, true);
    return;
  }
  if ("queued" in admitted && admitted.queued) {
    enqueuePinnedTask({
      operationId: message.operationId,
      projectId: admitted.projectId,
      text: message.text,
      cwd: message.cwd,
      agent,
      model: message.model,
    });
    await say("The pinned host is offline. The task is queued until the deadline.", undefined, true);
    return;
  }
  await say(`Creating a new ${displayName} task…`);
  const create = {
    claude: createClaudeSession,
    codex: createCodexSession,
    cursor: createCursorSession,
    grok: createGrokSession,
  }[agent];
  const result = await create(message.text, message.cwd, DELIVERY_TIMEOUT_MS, resolved.attachments);
  if (result.ok) {
    await say(result.text, result.sessionId, true);
  } else {
    await say(`Could not create a ${displayName} task: ${result.error}`, undefined, true);
  }
}

const ATTACHMENT_SWEEP_MS = 10 * 60_000;
let attachmentsSweptAt = 0;

/**
 * An attachment no message ever named is dropped once its time is up,
 * whether or not another one arrives: the sweep rides on the publish loop,
 * a few times an hour, instead of waiting for the next upload.
 */
export function sweepAttachments(now = Date.now()): number {
  if (now - attachmentsSweptAt < ATTACHMENT_SWEEP_MS) return 0;
  attachmentsSweptAt = now;
  return pruneAttachments(now);
}

/**
 * The attachments a message carries: the ones inside it, and the ones that
 * came ahead of it by id. One that never came is a rejection the phone reads
 * as "send them again, inline", not a message quietly delivered without its photo.
 */
export function resolveMessageAttachments(
  message: Pick<UserMessage, "attachments" | "attachmentRefs">,
  take: (attachmentId: string) => UserAttachment | undefined = takeAttachment,
): { ok: true; attachments: UserAttachment[] } | { ok: false; missing: string } {
  const attachments = [...(message.attachments ?? [])];
  for (const ref of message.attachmentRefs ?? []) {
    const stored = take(ref.attachmentId);
    if (!stored) return { ok: false, missing: ref.name };
    attachments.push(stored);
  }
  return { ok: true, attachments: attachments.slice(0, 5) };
}

export async function handleUserMessage(
  client: RelayClient,
  message: UserMessage,
): Promise<"accepted" | "rejected" | void> {
  const say = (text: string, sessionId?: string, wake = false) => {
    const payload = agentEventForUserMessage(message, text, sessionId);
    const options = { ttlMs: 15 * 60_000, wake: wake || undefined };
    return (sessionId
      ? sendSessionPayload(client, payload, sessionId, "phone", options)
      : client.send(payload, "phone", options)).catch(() => {});
  };
  const resolved = resolveMessageAttachments(message, (attachmentId) => takeAttachment(attachmentId, client.room));
  if (!resolved.ok) {
    if (message.messageId) {
      await sendDeliveryReceipt(client, message.messageId, "rejected", ATTACHMENT_MISSING_ERROR, message.sessionId);
    }
    return "rejected";
  }
  const attachments = resolved.attachments;

  if (!message.sessionId) {
    const agent = message.agent ?? "codex";
    const displayName = {
      claude: "Claude Code", codex: "Codex", cursor: "Cursor", grok: "Grok Build",
    }[agent];
    if (!loadRuntimeConfig().providerSettings[agent]) {
      await say(`${displayName} is disabled in GrantTap Settings.`, undefined, true);
      return;
    }
    const requestedCwd = message.cwd?.trim();
    if (requestedCwd) {
      const admitted = evaluateCreateTask({
        cwd: requestedCwd, agent, model: message.model,
        hostOnline: client.isConnected,
      });
      if (!admitted.ok) {
        await say(admitted.detail, undefined, true);
        return;
      }
    }
    await say(`Creating a new ${displayName} task…`);
    const create = {
      claude: createClaudeSession,
      codex: createCodexSession,
      cursor: createCursorSession,
      grok: createGrokSession,
    }[agent];
    const result = await create(message.text, requestedCwd, DELIVERY_TIMEOUT_MS, attachments);
    if (result.ok) {
      await say(result.text, result.sessionId, true);
    } else {
      await say(`Could not create a ${displayName} task: ${result.error}`, undefined, true);
    }
    return;
  }

  const target = scanSessions().sessions.find((session) => session.sessionId === message.sessionId);
  if (!target) {
    await say("This task is no longer available on the computer.", message.sessionId);
    return;
  }

  const settings = loadRuntimeConfig().providerSettings;
  if (target.agent in settings
    && settings[target.agent as keyof typeof settings] === false) {
    await say("This agent is disabled in GrantTap Settings.", message.sessionId, true);
    return;
  }

  const runtime = loadRuntimeConfig();
  const mcpServers = mcpServersForSession(
    target,
    runtime.sessionMcpDisabled[target.sessionId] ?? [],
  );
  if (message.preferredMcp && !mcpServers.some((server) =>
    server.name === message.preferredMcp && server.allowed)) {
    await say("The selected MCP server is not allowed for this task.", target.sessionId);
    return;
  }
  const skills = workspaceSkills(target.cwd);
  if (message.skill && !skills.some((skill) => skill.name === message.skill)) {
    await say("The selected project skill is no longer available in this task's folder.", target.sessionId);
    return;
  }
  if (
    message.skill &&
    (runtime.sessionSkillsDisabled[target.sessionId] ?? []).includes(message.skill)
  ) {
    await say("The selected project skill is disabled for this task.", target.sessionId);
    return;
  }

  // No "sent, waiting" line from a middleman: the delivery receipt already
  // marks the person's bubble, and the next words in the chat are the answer.
  const startedAt = Date.now();
  const result = await deliverToSession(target, message.text, DELIVERY_TIMEOUT_MS, attachments, {
    preferredMcp: message.preferredMcp,
    skill: message.skill,
    model: message.model,
    permissionMode: message.permissionMode,
    effort: message.effort,
  });
  // The run's turns are in the transcript, but a session holding this chat
  // open never sees them; the journal is how it finds out on its next prompt,
  // and the Task carries the same digest as progress.
  const noted = noteDeliveredRun(target, message.text, result, startedAt, Date.now());
  if (noted?.event) {
    await sendSessionPayload(client, noted.event, noted.event.taskId, "phone", { ttlMs: 24 * 60 * 60_000 })
      .catch(() => {});
  }
  if (result.ok) {
    await say(result.text, result.sessionId ?? target.sessionId, true);
  } else {
    await say(`Could not deliver the message: ${result.error}`, target.sessionId, true);
  }
}
