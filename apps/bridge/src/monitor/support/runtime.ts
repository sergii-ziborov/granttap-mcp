import { refreshCodexHooks } from "../../codex-hook-trust";
import { computerDisplayName } from "../../../../../packages/core/computer-name";
import { RelayClient } from "../../../../../packages/core/relay-client";
import type { Payload, SessionInfo, SessionsStatus } from "../../../../../packages/protocol/schema";
import { loadRuntimeConfig, autoAcceptLevelFor } from "../../config";
import { monitorLeadership } from "./leadership";
import { mcpServersForSession, workspaceSkills } from "../../capabilities";
import { inspectAgentIntegrations } from "../../install";
import { withCloudRunners } from "../../cloud-runners";
import { currentConfigRevision } from "../../config/commands";
import { currentInstanceEpoch } from "../../host/instance-epoch";
import { localMeshStore } from "../../mesh/local-remote/local";
import { refreshMcpLoad } from "../../machine-load/mcp/refresh";
import { approvalsStatus } from "../../approvals/state";
import { primeSessionKeys } from "../../host/session-keys";
import { meshCatalog } from "../../mesh/runtime";
import { HEARTBEAT_INTERVAL_MS, publishHeartbeat } from "./heartbeat";
import { confirmPendingController } from "../../pairing/controllers";
import { recordControllerName } from "../../pairing/presence";
import { startPublishLoop } from "./publish-loop";
import { singleFlightPublisher } from "./single-flight";
import { publishedCatalog, rememberPublishedCatalog, resumePublishedChats,
  publishCatalogHeads, stopCatalogHeads } from "../../session-catalog";
import { createMachineLoadPublisher } from "../../machine-load";
import { startMachineLoadLoop } from "../../machine-load/host/loop";
import { scanCapabilityUsage, scanSessionHistory, scanSessions, scopeCapabilityUsageToRoom, TOKEN_WINDOW_HOURS } from "../../sessions";
import { boundedCatalogHistory, INTERVAL_MS, publishSessionEvents } from "../handlers/catalog";
import { sweepAttachments } from "../handlers/receipts";
import { handleMonitorMessage } from "../handlers/inbound";

const HISTORY_INTERVAL_MS = 60_000;
const resumedHeads = new WeakSet<RelayClient>();
import { publishMonitorMeshes, stopMonitorMeshes } from "../mesh-publication";

export type SessionMonitor = {
  publish: () => Promise<void>;
  isLeader: () => boolean;
  close: () => void;
};

function decorateSessions(
  sessions: SessionsStatus["sessions"],
  subscriptions: Set<string>,
): SessionsStatus["sessions"] {
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
}

function monitorSnapshot(input: {
  includeHistory: boolean;
  forceHistory: boolean;
  subscriptions: Set<string>;
  history: (force?: boolean) => SessionsStatus["sessions"];
}): SessionsStatus {
  const { includeHistory, forceHistory, subscriptions, history } = input;
  sweepAttachments();
  if (loadRuntimeConfig().meshEnabled) localMeshStore().flush();
  const { sessions, tokensRecent } = scanSessions();
  const runtime = loadRuntimeConfig();
  return {
    type: "sessions.status",
    machine: computerDisplayName(),
    sessions: decorateSessions(sessions, subscriptions),
    history: includeHistory
      ? decorateSessions(boundedCatalogHistory(history(forceHistory), subscriptions), subscriptions)
      : undefined,
    tokensRecent,
    tokenWindowHours: TOKEN_WINDOW_HOURS,
    tokensAllTime: tokensRecent,
    gatingEnabled: runtime.enabled,
    excludedSessions: runtime.excludedSessions,
    autoAcceptDefault: runtime.autoAcceptDefault,
    autoAcceptBySession: Object.fromEntries(Object.keys(runtime.autoAcceptBySession)
      .map(id => [id, autoAcceptLevelFor(id)])),
    autoAcceptByProject: runtime.autoAcceptByProject,
    autoAcceptPaused: runtime.autoAcceptPaused,
    providerSettings: runtime.providerSettings,
    meshEnabled: runtime.meshEnabled,
    contextCompilerEnabled: runtime.contextCompilerEnabled,
    configRevision: currentConfigRevision(),
    instanceEpoch: currentInstanceEpoch(),
    agents: withCloudRunners(inspectAgentIntegrations()),
    generatedAt: Date.now(),
  };
}

async function publishMonitorTick(input: {
  client: RelayClient;
  leadership: ReturnType<typeof monitorLeadership>;
  subscriptions: Set<string>;
  history: (force?: boolean) => SessionsStatus["sessions"];
  clocks: { lastHistoryPublishedAt: number; lastCapabilityPublishedAt: number };
  loadLoop: { updateStatus: (status: SessionsStatus) => void };
  forceHistory: boolean;
}): Promise<{ lastHistoryPublishedAt: number; lastCapabilityPublishedAt: number }> {
  const { client, leadership, subscriptions, history, clocks, loadLoop, forceHistory } = input;
  let { lastHistoryPublishedAt, lastCapabilityPublishedAt } = clocks;
  if (!client.isConnected) return { lastHistoryPublishedAt, lastCapabilityPublishedAt };
  await publishHeartbeat(client).catch(() => {});
  if (!leadership.acquire()) return { lastHistoryPublishedAt, lastCapabilityPublishedAt };
  const initial = lastHistoryPublishedAt === 0;
  const includeHistory = forceHistory || (!initial && Date.now() - lastHistoryPublishedAt >= HISTORY_INTERVAL_MS);
  const status = monitorSnapshot({ includeHistory, forceHistory, subscriptions, history });
  rememberPublishedCatalog(client, status);
  await client.send(status, "phone", { ttlMs: INTERVAL_MS * 24, reliable: false });
  if (initial && !resumedHeads.has(client)) {
    resumedHeads.add(client);
    void resumePublishedChats(client,
      (session, saved) => publishSessionEvents(client, session.sessionId, saved)).catch(() => {});
  }
  // Provider review is independent of task visibility; a hung hook RPC must
  // never hold the current catalog behind its discovery timeout.
  void refreshCodexHooks().catch(() => {});
  if (includeHistory || initial) lastHistoryPublishedAt = Date.now();
  loadLoop.updateStatus(status);
  void refreshMcpLoad(status.sessions).catch(() => {});
  publishCatalogHeads(client, status, subscriptions, publishSessionEvents);
  await client.send(approvalsStatus(), "phone", { ttlMs: INTERVAL_MS * 3, reliable: false });
  if (loadRuntimeConfig().meshEnabled) publishMonitorMeshes(client, status);
  if (Date.now() - lastCapabilityPublishedAt >= 30_000) {
    const usage = scanCapabilityUsage([
      ...status.sessions,
      ...history(false),
    ]);
    await client.send(scopeCapabilityUsageToRoom(usage, client.room), "phone", { ttlMs: 90_000, reliable: false });
    lastCapabilityPublishedAt = Date.now();
  }
  return { lastHistoryPublishedAt, lastCapabilityPublishedAt };
}

/**
 * Attach task discovery and phone-to-agent delivery to the same relay client
 * used by MCP tools. This keeps STDIO stdout clean and removes the old need for
 * a separate `granttap-mcp monitor` terminal process.
 */
export function startSessionMonitor(client: RelayClient): SessionMonitor {
  const subscriptions = new Set<string>();
  const leadership = monitorLeadership();
  primeSessionKeys(client);
  publishedCatalog(client);
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

  const history = (force = false): SessionsStatus["sessions"] => {
    if (force || !historyCache || Date.now() - historyCache.generatedAt > 60_000) {
      historyCache = { generatedAt: Date.now(), sessions: scanSessionHistory() };
    }
    return historyCache.sessions;
  };

  const publish = singleFlightPublisher(async (forceHistory: boolean): Promise<void> => {
    const next = await publishMonitorTick({
      client, leadership, subscriptions, history, loadLoop, forceHistory,
      clocks: { lastHistoryPublishedAt, lastCapabilityPublishedAt },
    });
    lastHistoryPublishedAt = next.lastHistoryPublishedAt;
    lastCapabilityPublishedAt = next.lastCapabilityPublishedAt;
  });

  const off = client.onMessage(async (payload: Payload, peerPublicKey) => {
    if (payload.type === "hello" && payload.role === "phone") {
      confirmPendingController(client.room, peerPublicKey);
      recordControllerName(peerPublicKey, payload.deviceName);
    }
    return handleMonitorMessage(client, payload, { leadership, subscriptions, publish, peerPublicKey });
  });

  const stopCatalog = startPublishLoop({
    connected: () => client.isConnected,
    intervalMs: INTERVAL_MS,
    immediate: true,
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
    isLeader: () => leadership.acquire(),
    close: () => {
      stopCatalog();
      stopCatalogHeads(client);
      stopMonitorMeshes(client);
      stopHeartbeat();
      loadLoop.stop();
      off();
      subscriptions.clear();
      leadership.release();
    },
  };
}
