import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RelayClient } from "../../../packages/core/relay-client";
import type {
  ConfigSet,
  ScheduleDelete,
  SchedulePlanRequest,
  ScheduleRun,
  ScheduleSet,
  SessionAccessSet,
  SessionCompact,
  SessionMcpSet,
  SessionSubscription,
  SessionsStatus,
  UserMessage,
} from "../../../packages/protocol/schema";
import { configDir, loadRuntimeConfig, saveRuntimeConfig } from "./config";
import { mcpServersForSession, workspaceSkills } from "./capabilities";
import { compactCodexSession } from "./codex-control";
import { createClaudeSession, createCodexSession, deliverToSession } from "./reply";
import { abandonDelivery, beginDelivery, completeDelivery } from "./delivery";
import { inspectAgentIntegrations } from "./install";
import { primeSessionKeys, sendSessionPayload } from "./session-keys";
import {
  scanCapabilityUsage,
  scanSessionActivity,
  scanSessionHistory,
  scanSessions,
  TOKEN_WINDOW_HOURS,
} from "./sessions";
import {
  deleteSchedule,
  planSchedule,
  runScheduleNow,
  scheduledSnapshot,
  scheduleHistorySnapshot,
  setSchedule,
  tickSchedules,
} from "./scheduler";

const INTERVAL_MS = Number(
  process.env.GRANTTAP_MONITOR_INTERVAL_MS ?? process.env.NODVOX_MONITOR_INTERVAL_MS ?? 5_000,
);

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

  const decorate = (sessions: SessionsStatus["sessions"]): SessionsStatus["sessions"] => {
    const runtime = loadRuntimeConfig();
    return sessions.map((session) => ({
      ...session,
      accessLevel: runtime.sessionAccess[session.sessionId] ?? session.accessLevel,
      mcpServers: mcpServersForSession(
        session,
        runtime.sessionMcpDisabled[session.sessionId] ?? [],
      ),
      skills: workspaceSkills(session.cwd),
    }));
  };

  const history = (): SessionsStatus["sessions"] => {
    if (!historyCache || Date.now() - historyCache.generatedAt > 60_000) {
      historyCache = { generatedAt: Date.now(), sessions: decorate(scanSessionHistory()) };
    }
    return historyCache.sessions;
  };

  const snapshot = (includeHistory: boolean): SessionsStatus => {
    const { sessions, tokensRecent } = scanSessions();
    const runtime = loadRuntimeConfig();
    return {
      type: "sessions.status",
      machine: hostname(),
      sessions: decorate(sessions),
      history: includeHistory ? history() : undefined,
      tokensRecent,
      tokenWindowHours: TOKEN_WINDOW_HOURS,
      tokensAllTime: tokensRecent,
      gatingEnabled: runtime.enabled,
      excludedSessions: runtime.excludedSessions,
      agents: inspectAgentIntegrations(),
      generatedAt: Date.now(),
    };
  };

  const publish = async (): Promise<void> => {
    if (!leadership.acquire()) return;
    tickSchedules();
    if (!client.isConnected) return;
    const includeHistory = Date.now() - lastHistoryPublishedAt >= 30_000;
    const status = snapshot(includeHistory);
    await client.send(status, "phone", { ttlMs: INTERVAL_MS * 3 });
    if (includeHistory) lastHistoryPublishedAt = Date.now();
    if (Date.now() - lastCapabilityPublishedAt >= 30_000) {
      await client.send(scanCapabilityUsage(status.sessions), "phone", { ttlMs: 90_000 });
      lastCapabilityPublishedAt = Date.now();
    }
    await client.send(
      {
        type: "schedules.status",
        tasks: scheduledSnapshot(),
        history: scheduleHistorySnapshot(),
        generatedAt: Date.now(),
      },
      "phone",
      { ttlMs: INTERVAL_MS * 3 },
    );
    for (const sessionId of subscriptions) {
      const session = [...status.sessions, ...(status.history ?? history())]
        .find((item) => item.sessionId === sessionId);
      if (session) {
        await sendSessionPayload(client, scanSessionActivity(session), sessionId, "phone",
          { ttlMs: INTERVAL_MS * 3 });
      }
    }
  };

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
      handleSubscription(subscriptions, payload);
      void publish().catch(() => {});
      return true;
    } else if (payload.type === "session.access.set") {
      handleAccessSet(payload);
      void publish().catch(() => {});
      return true;
    } else if (payload.type === "session.mcp.set") {
      handleMcpSet(payload);
      void publish().catch(() => {});
      return true;
    } else if (payload.type === "session.compact") {
      await handleCompact(client, payload);
      void publish().catch(() => {});
      return true;
    } else if (payload.type === "schedule.set") {
      handleScheduleSet(payload);
      void publish().catch(() => {});
      return true;
    } else if (payload.type === "schedule.delete") {
      handleScheduleDelete(payload);
      void publish().catch(() => {});
      return true;
    } else if (payload.type === "schedule.run") {
      handleScheduleRun(payload);
      void publish().catch(() => {});
      return true;
    } else if (payload.type === "schedule.plan.request") {
      await handleSchedulePlan(client, payload);
      return true;
    }
    return false;
  });

  const timer = setInterval(() => void publish().catch(() => {}), INTERVAL_MS);
  timer.unref?.();

  return {
    publish,
    close: () => {
      clearInterval(timer);
      off();
      subscriptions.clear();
      leadership.release();
    },
  };
}

async function sendDeliveryReceipt(
  client: RelayClient,
  messageId: string,
  status: "accepted" | "rejected",
  error?: string,
  sessionId?: string,
): Promise<void> {
  const payload = { type: "delivery.receipt" as const, messageId, status, error, receivedAt: Date.now() };
  const options = { ttlMs: 24 * 60 * 60_000 };
  await (sessionId
    ? sendSessionPayload(client, payload, sessionId, "phone", options)
    : client.send(payload, "phone", options)).catch(() => {});
}

function handleScheduleSet(message: ScheduleSet): void {
  setSchedule(message);
}

function handleScheduleDelete(message: ScheduleDelete): void {
  deleteSchedule(message.id);
}

function handleScheduleRun(message: ScheduleRun): void {
  runScheduleNow(message.id);
}

async function handleSchedulePlan(client: RelayClient, message: SchedulePlanRequest): Promise<void> {
  const result = await planSchedule(message);
  await client.send(result, "phone", { ttlMs: 5 * 60_000 }).catch(() => {});
}

function handleAccessSet(message: SessionAccessSet): void {
  const runtime = loadRuntimeConfig();
  runtime.sessionAccess[message.sessionId] = message.accessLevel;
  saveRuntimeConfig(runtime);
}

function handleMcpSet(message: SessionMcpSet): void {
  const runtime = loadRuntimeConfig();
  const disabled = new Set(runtime.sessionMcpDisabled[message.sessionId] ?? []);
  if (message.allowed) disabled.delete(message.serverName);
  else disabled.add(message.serverName);
  runtime.sessionMcpDisabled[message.sessionId] = [...disabled].sort();
  saveRuntimeConfig(runtime);
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
function monitorLeadership(): { acquire: () => boolean; release: () => void } {
  const path = join(configDir(), "monitor.lock");
  const token = `${process.pid}:${randomUUID()}`;
  let leader = false;

  const ownsLock = (): boolean => {
    try {
      return readFileSync(path, "utf8") === token;
    } catch {
      return false;
    }
  };

  const ownerIsAlive = (): boolean => {
    try {
      const raw = readFileSync(path, "utf8");
      const pid = Number(raw.split(":", 1)[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };

  const acquire = (): boolean => {
    if (leader) {
      leader = ownsLock();
      if (leader) return true;
    }

    mkdirSync(configDir(), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(path, "wx", 0o600);
        try {
          writeFileSync(fd, token);
        } finally {
          closeSync(fd);
        }
        leader = true;
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
        if (ownerIsAlive()) return false;
        try {
          unlinkSync(path);
        } catch {
          return false;
        }
      }
    }
    return false;
  };

  const release = (): void => {
    if (!leader || !ownsLock()) return;
    try {
      unlinkSync(path);
    } catch {
      // A successor may already have reclaimed a stale lock.
    }
    leader = false;
  };

  acquire();
  return { acquire, release };
}

function handleSubscription(subscriptions: Set<string>, message: SessionSubscription): void {
  if (message.active) subscriptions.add(message.sessionId);
  else subscriptions.delete(message.sessionId);
}

function handleConfigSet(message: ConfigSet): void {
  const runtime = loadRuntimeConfig();
  if (typeof message.enabled === "boolean") runtime.enabled = message.enabled;
  if (message.excludeSession && !runtime.excludedSessions.includes(message.excludeSession)) {
    runtime.excludedSessions.push(message.excludeSession);
  }
  if (message.includeSession) {
    runtime.excludedSessions = runtime.excludedSessions.filter((id) => id !== message.includeSession);
  }
  saveRuntimeConfig(runtime);
}

async function handleUserMessage(client: RelayClient, message: UserMessage): Promise<void> {
  const say = (text: string, sessionId?: string, wake = false) => {
    const payload = {
          type: "agent.event",
          text,
          requestId: message.requestId,
          kind: "response",
          sessionId,
          createdAt: Date.now(),
        } as const;
    const options = { ttlMs: 15 * 60_000, wake: wake || undefined };
    return (sessionId
      ? sendSessionPayload(client, payload, sessionId, "phone", options)
      : client.send(payload, "phone", options)).catch(() => {});
  };

  if (!message.sessionId) {
    const agent = message.agent === "claude" ? "claude" : "codex";
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
    await say(`Creating a new ${agent === "claude" ? "Claude Code" : "Codex"} task…`);
    const result = agent === "claude"
      ? await createClaudeSession(message.text, requestedCwd, 240_000, message.attachments)
      : await createCodexSession(message.text, requestedCwd, 240_000, message.attachments);
    if (result.ok) {
      await say(result.text, result.sessionId, true);
    } else {
      await say(`Could not create a ${agent === "claude" ? "Claude Code" : "Codex"} task: ${result.error}`, undefined, true);
    }
    return;
  }

  const target = scanSessions().sessions.find((session) => session.sessionId === message.sessionId);
  if (!target) {
    await say("This task is no longer available on the computer.", message.sessionId);
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

  await say("Sent to the task. Waiting for the answer…", target.sessionId);
  const result = await deliverToSession(target, message.text, 240_000, message.attachments, {
    preferredMcp: message.preferredMcp,
    skill: message.skill,
  });
  if (result.ok) {
    await say(result.text, result.sessionId ?? target.sessionId, true);
  } else {
    await say(`Could not deliver the message: ${result.error}`, target.sessionId, true);
  }
}
