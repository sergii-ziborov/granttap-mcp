import { runtimeWorkTracker } from "../../runtime-updates/readiness";
import { providerLogins } from '../../device-management/login';
import { deviceManagementWorkActive } from '../../device-management';
import { refreshCodexHooks } from "../../codex-hook-trust";
import { computerDisplayName } from "../../../../../packages/core/computer-name";
import { RelayClient } from "../../../../../packages/core/relay-client";
import type { Payload, SessionInfo, SessionsStatus } from "../../../../../packages/protocol/schema";
import { loadRuntimeConfig, autoAcceptLevelFor } from "../../config";
import { monitorLeadership } from "./leadership";
import { mcpServersForSession, workspaceSkills, refreshCodexMcpDescriptors } from "../../capabilities";
import { prepareMonitorInspection, type CatalogInspection } from "../../mesh/catalog";
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
import { openChatUpdates, OPEN_CHAT_INTERVAL_MS } from "../../session-catalog/open-chat-updates";
import { singleFlightPublisher } from "./single-flight";
import { publishedCatalog, rememberPublishedCatalog, resumePublishedChats,
  publishCatalogHeads, stopCatalogHeads } from "../../session-catalog";
import { createMachineLoadPublisher } from "../../machine-load";
import { startMachineLoadLoop } from "../../machine-load/host/loop";
import { scanSessionHistoryCooperatively, scanSessionsCooperatively, TOKEN_WINDOW_HOURS } from "../../sessions";
import { boundedCatalogHistory, INTERVAL_MS, publishSessionEvents } from "../handlers/catalog";
import { sweepAttachments } from "../handlers/receipts";
import { handleMonitorMessage } from "../handlers/inbound";
import { decorateTaskOriginCatalog } from '../../task-origins';
import { publishCodexQuestions } from '../../codex-questions';

const HISTORY_INTERVAL_MS = 60_000;
const resumedHeads = new WeakSet<RelayClient>();
import { publishMonitorMeshes, stopMonitorMeshes } from "../mesh-publication";
import { publishMonitorCapabilities, stopMonitorCapabilities } from "../capability-publication";

export type SessionMonitor = {
  publish: () => Promise<void>;
  isLeader: () => boolean;
  canUpdate: () => boolean;
  close: () => void;
};

function decorateSessions(
  sessions: SessionsStatus["sessions"],
  subscriptions: Set<string>,
  inspection?: CatalogInspection,
): SessionsStatus["sessions"] {
  const runtime = loadRuntimeConfig();
  const visible = sessions.filter((session) =>
    runtime.providerSettings[session.agent as keyof typeof runtime.providerSettings] !== false
  );
  const coordinated = runtime.meshEnabled ? meshCatalog(visible, inspection) : visible;
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

async function monitorSnapshot(input: {
  includeHistory: boolean;
  forceHistory: boolean;
  subscriptions: Set<string>;
  history: (force?: boolean) => Promise<SessionsStatus["sessions"]>;
}): Promise<SessionsStatus> {
  const { includeHistory, forceHistory, subscriptions, history } = input;
  sweepAttachments();
  if (loadRuntimeConfig().meshEnabled) localMeshStore().flush();
  const { sessions, tokensRecent } = await scanSessionsCooperatively();
  const runtime = loadRuntimeConfig();
  const historical = includeHistory ? boundedCatalogHistory(await history(forceHistory), subscriptions) : undefined;
  const all = [...sessions, ...(historical ?? [])].filter(session =>
    runtime.providerSettings[session.agent as keyof typeof runtime.providerSettings] !== false);
  if (all.some(session => session.agent === 'codex')) await refreshCodexMcpDescriptors();
  const directories = all.flatMap(session => [session.worktree, session.cwd].filter((path): path is string => !!path));
  const inspection = runtime.meshEnabled ? await prepareMonitorInspection(directories, forceHistory) : undefined;
  return {
    type: "sessions.status",
    machine: computerDisplayName(),
    sessions: decorateSessions(sessions, subscriptions, inspection),
    history: historical ? decorateSessions(historical, subscriptions, inspection) : undefined,
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
  history: (force?: boolean) => Promise<SessionsStatus["sessions"]>;
  clocks: { lastHistoryPublishedAt: number };
  loadLoop: { updateStatus: (status: SessionsStatus) => void };
  forceHistory: boolean;
  active: () => boolean;
}): Promise<{ lastHistoryPublishedAt: number }> {
  const { client, leadership, subscriptions, history, clocks, loadLoop, forceHistory } = input;
  let { lastHistoryPublishedAt } = clocks;
  if (!client.isConnected) return { lastHistoryPublishedAt };
  await publishHeartbeat(client).catch(() => {});
  if (!input.active()) return { lastHistoryPublishedAt };
  if (!leadership.acquire()) return { lastHistoryPublishedAt };
  await client.send(approvalsStatus(), "phone", { ttlMs: INTERVAL_MS * 3, reliable: false });
  const initial = lastHistoryPublishedAt === 0;
  if (initial && !resumedHeads.has(client)) {
    const saved = publishedCatalog(client);
    if (saved) await client.send(saved, "phone", { ttlMs: INTERVAL_MS * 24, reliable: false });
    if (!input.active()) return { lastHistoryPublishedAt };
    resumedHeads.add(client);
    void resumePublishedChats(client,
      (session, saved) => publishSessionEvents(client, session.sessionId, saved)).catch(() => {});
  }
  const includeHistory = forceHistory || (!initial && Date.now() - lastHistoryPublishedAt >= HISTORY_INTERVAL_MS);
  const snapshot = await monitorSnapshot({ includeHistory, forceHistory, subscriptions, history });
  if (!input.active()) return { lastHistoryPublishedAt };
  const status = decorateTaskOriginCatalog(snapshot, client.room);
  rememberPublishedCatalog(client, status);
  await client.send(status, "phone", { ttlMs: INTERVAL_MS * 24, reliable: false });
  // Provider review is independent of task visibility; a hung hook RPC must
  // never hold the current catalog behind its discovery timeout.
  void refreshCodexHooks().catch(() => {});
  if (includeHistory || initial) lastHistoryPublishedAt = Date.now();
  loadLoop.updateStatus(status);
  void refreshMcpLoad(status.sessions).catch(() => {});
  publishCatalogHeads(client, status, subscriptions, publishSessionEvents);
  if (loadRuntimeConfig().meshEnabled) publishMonitorMeshes(client, status);
  publishMonitorCapabilities(client, status, () => history(false));
  return { lastHistoryPublishedAt };
}

/**
 * Attach task discovery and phone-to-agent delivery to the same relay client
 * used by MCP tools. This keeps STDIO stdout clean and removes the old need for
 * a separate `granttap-mcp monitor` terminal process.
 */
export function startSessionMonitor(client: RelayClient): SessionMonitor {
  const subscriptions = new Set<string>();
  const leadership = monitorLeadership(Date.now, undefined, () => client.isConnected);
  restoreMonitorState(client);
  let historyCache: { generatedAt: number; sessions: SessionsStatus["sessions"] } | undefined;
  let historyRead: Promise<SessionsStatus["sessions"]> | undefined;
  let lastHistoryPublishedAt = 0;
  let closed = false;
  const work = runtimeWorkTracker(() => approvalsStatus().pending.length > 0 || providerLogins.active() || deviceManagementWorkActive());
  const loadLoop = monitorLoadLoop(client, leadership);

  const history = (force = false): Promise<SessionsStatus["sessions"]> => {
    if (historyRead) return historyRead;
    if (!force && historyCache && Date.now() - historyCache.generatedAt <= 60_000) {
      return Promise.resolve(historyCache.sessions);
    }
    historyRead = scanSessionHistoryCooperatively().then(sessions => {
      historyCache = { generatedAt: Date.now(), sessions };
      return sessions;
    }).finally(() => { historyRead = undefined; });
    return historyRead;
  };

  const publish = singleFlightPublisher(async (forceHistory: boolean): Promise<void> => {
    if (closed) return;
    const next = await publishMonitorTick({
      client, leadership, subscriptions, history, loadLoop, forceHistory,
      active: () => !closed,
      clocks: { lastHistoryPublishedAt },
    });
    lastHistoryPublishedAt = next.lastHistoryPublishedAt;
  });

  const off = client.onMessage((payload: Payload, peerPublicKey) => work.run(async () => {
    if (payload.type === "hello" && payload.role === "phone") {
      confirmPendingController(client.room, peerPublicKey);
      recordControllerName(peerPublicKey, payload.deviceName);
      if (leadership.acquire()) {
        await client.send(approvalsStatus(), 'phone', { peerPublicKey, reliable: false, ttlMs: 90_000 })
          .catch(() => {});
        await replayNativeQuestions(client, peerPublicKey);
      }
    }
    return await handleMonitorMessage(client, payload, { leadership, subscriptions, publish, peerPublicKey });
  }));

  const offConnected = client.onConnected?.(() => publish().catch(() => {}));

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
  const stopQuestions = startQuestionLoop(client, leadership, subscriptions);
  const stopChats = startPublishLoop({
    connected: () => client.isConnected,
    intervalMs: OPEN_CHAT_INTERVAL_MS,
    publish: openChatUpdates({
      catalog: () => publishedCatalog(client), subscriptions,
      active: () => !closed && client.isConnected && leadership.acquire(),
      publish: (id, status) => publishSessionEvents(client, id, status),
    }),
  });

  return {
    publish: () => publish(false),
    isLeader: () => leadership.acquire(),
    canUpdate: work.idle,
    close: () => {
      closed = true;
      offConnected?.();
      stopCatalog();
      stopCatalogHeads(client);
      stopMonitorCapabilities(client);
      stopMonitorMeshes(client);
      stopHeartbeat();
      stopQuestions();
      stopChats();
      loadLoop.stop();
      off();
      subscriptions.clear();
      leadership.release();
    },
  };
}

function startQuestionLoop(client: RelayClient, leadership: { acquire: () => boolean }, subscriptions: Set<string>) {
  return startPublishLoop({
    connected: () => client.isConnected,
    intervalMs: 2_000,
    immediate: true,
    publish: async () => {
      if (!leadership.acquire()) return;
      const known = publishedCatalog(client);
      if (known) await publishCodexQuestions(client, [...known.sessions,
        ...(known.history ?? []).filter(s => subscriptions.has(s.sessionId))]).catch(() => {});
    },
  });
}

async function replayNativeQuestions(client: RelayClient, peerPublicKey: string) {
  const known = publishedCatalog(client);
  if (known) await publishCodexQuestions(client, known.sessions, { replay: true, peerPublicKey }).catch(() => {});
}

function restoreMonitorState(client: RelayClient): void {
  primeSessionKeys(client);
  publishedCatalog(client);
}

function monitorLoadLoop(client: RelayClient, leadership: ReturnType<typeof monitorLeadership>) {
  const publishMachineLoad = createMachineLoadPublisher({
    log: (line) => process.stderr.write(`[monitor] ${line}\n`),
  });
  return startMachineLoadLoop({
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
}
