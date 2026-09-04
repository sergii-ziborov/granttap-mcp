import { hostname } from "node:os";
import { RelayClient } from "../../../packages/core/relay-client";
import type {
  AgentEvent,
  ConfigSet,
  SessionAccessSet,
  SessionCompact,
  SessionInfo,
  SessionMcpSet,
  SessionShellSet,
  SessionSkillSet,
  SessionSubscription,
  SessionsStatus,
  UserMessage,
} from "../../../packages/protocol/schema";
import {
  configDir,
  loadRuntimeConfig,
  saveRuntimeConfig,
  setSessionMcpAllowed,
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
} from "./reply";
import { abandonDelivery, beginDelivery, completeDelivery } from "./delivery";
import { inspectAgentIntegrations } from "./install";
import { refreshMcpLoad } from "./machine-load/mcp-load-refresh";
import { approvalsStatus } from "./approval-state";
import { primeSessionKeys, sendSessionPayload } from "./session-keys";
import { sendMeshPayload } from "./session-keys";
import { handleMeshPayload, meshCatalog, meshSnapshots, prepareMeshHandoff } from "./mesh/runtime";
import { deriveObservedClaims } from "./mesh/observed-claims";
import { localMeshStore } from "./mesh/local";
import { cachedSessionActivity } from "./monitor-session-activity";
import { HEARTBEAT_INTERVAL_MS, publishHeartbeat } from "./monitor-heartbeat";
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
): Promise<boolean> {
  const session = resolveSession(sessionId, status);
  if (!session) return false;
  await sendSessionPayload(client, cachedSessionActivity(session), sessionId, "phone", {
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
  const publishMachineLoad = createMachineLoadPublisher();
  const loadLoop = startMachineLoadLoop({
    connected: () => client.isConnected,
    publish: (status, intervalMs) => publishMachineLoad(client, status, intervalMs),
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
      agents: inspectAgentIntegrations(),
      generatedAt: Date.now(),
    };
  };

  const publish = singleFlightPublisher(async (forceHistory: boolean): Promise<void> => {
    if (!leadership.acquire()) return;
    if (!client.isConnected) return;
    // Discovery is synchronous, multi-second filesystem work: once it starts,
    // the event loop cannot service the socket and the heartbeat loop cannot
    // fire. Spend the last free moment proving the machine is alive.
    await publishHeartbeat(client).catch(() => {});
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
        await handleUserMessage(client, payload);
        if (payload.messageId && deliveryStarted) {
          completeDelivery(payload.messageId);
          await sendDeliveryReceipt(client, payload.messageId, "accepted", undefined, payload.sessionId);
        }
        void publish().catch(() => {});
        return true;
      } catch {
        if (payload.messageId && deliveryStarted) abandonDelivery(payload.messageId);
        return false;
      }
    } else if (payload.type === "config.set") {
      handleConfigSet(payload);
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
      void publishSessionEvents(client, payload.sessionId).catch(() => false);
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
    } else if (payload.type === "project.policy.set" && loadRuntimeConfig().meshEnabled) {
      return handleProjectPolicySet(client, payload);
    } else if ((payload.type === "mesh.event" || payload.type === "mesh.snapshot")
      && loadRuntimeConfig().meshEnabled) {
      await handleMeshPayload(client, payload);
      void publish().catch(() => {});
      return true;
    } else if (payload.type === "mesh.handoff.prepare" && loadRuntimeConfig().meshEnabled) {
      const prepared = await prepareMeshHandoff(client, payload);
      if (prepared) void publish().catch(() => {});
      return prepared;
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
  const runtime = loadRuntimeConfig();
  if (typeof message.enabled === "boolean") runtime.enabled = message.enabled;
  if (message.excludeSession && !runtime.excludedSessions.includes(message.excludeSession)) {
    runtime.excludedSessions.push(message.excludeSession);
  }
  if (message.includeSession) {
    runtime.excludedSessions = runtime.excludedSessions.filter((id) => id !== message.includeSession);
  }
  // Auto-accept is configured from iOS only; this is the write path the phone
  // uses. The hooks never change these — they just read the persisted level.
  if (message.autoAcceptDefault) runtime.autoAcceptDefault = message.autoAcceptDefault;
  if (typeof message.autoAcceptPaused === "boolean") {
    runtime.autoAcceptPaused = message.autoAcceptPaused;
  }
  if (message.autoAcceptSession) {
    const { sessionId, level } = message.autoAcceptSession;
    if (level == null) delete runtime.autoAcceptBySession[sessionId];
    else runtime.autoAcceptBySession[sessionId] = level;
  }
  if (message.provider && typeof message.providerEnabled === "boolean") {
    runtime.providerSettings = {
      ...runtime.providerSettings,
      [message.provider]: message.providerEnabled,
    };
  }
  if (typeof message.meshEnabled === "boolean") runtime.meshEnabled = message.meshEnabled;
  saveRuntimeConfig(runtime);
  process.stderr.write(
    `[monitor] config: gating=${runtime.enabled ? "on" : "OFF"}, ` +
      `auto=${runtime.autoAcceptPaused ? "paused" : runtime.autoAcceptDefault}, ` +
      `excluded=${runtime.excludedSessions.length}, mesh=${runtime.meshEnabled ? "on" : "OFF"}\n`,
  );
}

export async function handleUserMessage(client: RelayClient, message: UserMessage): Promise<void> {
  const say = (text: string, sessionId?: string, wake = false) => {
    const payload = agentEventForUserMessage(message, text, sessionId);
    const options = { ttlMs: 15 * 60_000, wake: wake || undefined };
    return (sessionId
      ? sendSessionPayload(client, payload, sessionId, "phone", options)
      : client.send(payload, "phone", options)).catch(() => {});
  };

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
      const known = [...scanSessions().sessions, ...scanSessionHistory()].some((session) =>
        session.agent === agent && session.cwd === requestedCwd);
      if (!known) {
        await say("That project folder is not one of the agent workspaces currently advertised to this phone.",
          undefined, true);
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
    const result = await create(message.text, requestedCwd, 240_000, message.attachments);
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

  await say("Sent to the task. Waiting for the answer…", target.sessionId);
  const result = await deliverToSession(target, message.text, 240_000, message.attachments, {
    preferredMcp: message.preferredMcp,
    skill: message.skill,
    model: message.model,
    permissionMode: message.permissionMode,
    effort: message.effort,
  });
  if (result.ok) {
    await say(result.text, result.sessionId ?? target.sessionId, true);
  } else {
    await say(`Could not deliver the message: ${result.error}`, target.sessionId, true);
  }
}
