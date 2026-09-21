/**
 * Cached, provider-aware session catalog.
 *
 * Provider readers parse each bounded JSONL once and retain capability
 * observations beside their session summary. Activity and telemetry therefore
 * do not trigger a second filesystem walk during the monitor publish cycle.
 */
import { recentProjectDecisions } from "../policy/decision-log";
import type {
  ActivityEntry,
  CapabilityUsageStatus,
  RemoteCapabilityUsageEvent,
  SessionActivity,
  SessionInfo,
} from "../../../../packages/protocol/schema";
import {
  MAX_ACTIVITY_ENTRIES,
  MAX_ACTIVITY_TEXT,
} from "./support/activity-helpers";
import {
  MAX_HISTORY,
  MAX_FILES,
  MAX_LIVE,
  TOKEN_WINDOW_HOURS,
  TOKEN_WINDOW_MS,
} from "./support/common";
import {
  claudeActivity,
  claudeCapabilityUsage,
  scanClaude,
} from "./scan/claude";
import {
  codexActivity,
  codexCapabilityUsage,
  scanCodex,
} from "./scan/codex";
import {
  cursorActivity,
  cursorCapabilityUsage,
  scanCursor,
} from "./cursor";
import { grokActivity, grokCapabilityUsage, scanGrok } from "./scan/grok";
import {
  limitCapabilityUsageEvents,
  rememberCapabilityUsageCandidate,
  toRemoteCapabilityUsageEvent,
} from "./telemetry";
import { createCapabilityTotals } from "./support/capability-totals";
import { loadRuntimeConfig } from "../config";
import { timedProviderScan } from "../machine-load/mcp/scan-cost";

export { MAX_ACTIVITY_ENTRIES, MAX_ACTIVITY_TEXT, TOKEN_WINDOW_HOURS };

type ProviderScan = ReturnType<typeof scanClaude>;

function sessionKey(session: SessionInfo): string {
  return `${session.agent}\0${session.sessionId}`;
}

function emptyScan(): ProviderScan {
  return { sessions: [], tokensRecent: 0 };
}

/**
 * Explicit provider roots isolate fixtures and diagnostics from real user logs.
 * In normal operation (no overrides) every installed provider is scanned.
 */
function providerScans(maxFiles = MAX_FILES): ProviderScan[] {
  const enabled = loadRuntimeConfig().providerSettings;
  const explicit = {
    claude: Boolean(process.env.GRANTTAP_CLAUDE_PROJECTS_DIR || process.env.NODVOX_CLAUDE_PROJECTS_DIR),
    codex: Boolean(process.env.GRANTTAP_CODEX_SESSIONS_DIR || process.env.NODVOX_CODEX_SESSIONS_DIR),
    cursor: Boolean(process.env.GRANTTAP_CURSOR_TRANSCRIPTS_DIR || process.env.GRANTTAP_CURSOR_STATE_DB),
    grok: Boolean(process.env.GRANTTAP_GROK_SESSIONS_DIR || process.env.GROK_HOME),
  };
  const isolated = Object.values(explicit).some(Boolean);
  return [
    enabled.claude && (!isolated || explicit.claude)
      ? timedProviderScan("claude", () => scanClaude(maxFiles)) : emptyScan(),
    enabled.codex && (!isolated || explicit.codex)
      ? timedProviderScan("codex", () => scanCodex(maxFiles)) : emptyScan(),
    enabled.cursor && (!isolated || explicit.cursor)
      ? timedProviderScan("cursor", () => scanCursor(maxFiles)) : emptyScan(),
    enabled.grok && (!isolated || explicit.grok)
      ? timedProviderScan("grok", () => scanGrok(maxFiles)) : emptyScan(),
  ];
}

function sortedUniqueSessions(scans: ProviderScan[]): SessionInfo[] {
  const merged = new Map<string, SessionInfo>();
  for (const session of scans.flatMap((scan) => scan.sessions)) {
    const key = sessionKey(session);
    const previous = merged.get(key);
    if (!previous || session.lastActivityAt >= previous.lastActivityAt) {
      merged.set(key, session);
    }
  }
  const rank = { working: 0, waiting: 1, idle: 2 } as const;
  return [...merged.values()].sort((a, b) =>
    rank[a.state] - rank[b.state] || b.lastActivityAt - a.lastActivityAt
  );
}

/** Preserve provider diversity when one agent has hundreds of recent logs. */
function pickWithReserve(
  candidates: SessionInfo[],
  limit: number,
  reservePerAgent: number,
): SessionInfo[] {
  if (candidates.length <= limit) return candidates;
  const picked = new Map<string, SessionInfo>();
  const agents = [...new Set(candidates.map((session) => session.agent))];
  for (const agent of agents) {
    for (const session of candidates.filter((item) => item.agent === agent).slice(0, reservePerAgent)) {
      if (picked.size >= limit) break;
      picked.set(sessionKey(session), session);
    }
  }
  for (const session of candidates) {
    if (picked.size >= limit) break;
    picked.set(sessionKey(session), session);
  }
  const order = new Map(candidates.map((session, index) => [sessionKey(session), index]));
  return [...picked.values()].sort(
    (a, b) => (order.get(sessionKey(a)) ?? 0) - (order.get(sessionKey(b)) ?? 0),
  );
}

function scanCatalog(maxFiles = MAX_FILES): { all: SessionInfo[]; tokensRecent: number; sourceLimited: boolean } {
  const scans = providerScans(maxFiles);
  return {
    all: sortedUniqueSessions(scans),
    tokensRecent: scans.reduce((sum, scan) => sum + scan.tokensRecent, 0),
    sourceLimited: scans.some((scan) => scan.sourceLimited === true),
  };
}

export function scanSessions(): { sessions: SessionInfo[]; tokensRecent: number } {
  const { all, tokensRecent } = scanCatalog();
  const live = all.filter((session) =>
    session.state !== "idle" || Date.now() - session.lastActivityAt <= TOKEN_WINDOW_MS
  );
  return {
    sessions: pickWithReserve(live, MAX_LIVE, 10),
    tokensRecent,
  };
}

/** Bounded local history. Nested provider threads stay metadata on their parent. */
export function scanSessionHistory(): SessionInfo[] {
  return pickWithReserve(scanCatalog().all, Math.min(MAX_HISTORY, 200), 40);
}

/** The UI asks for older catalog rows only when its History list reaches the end. */
export function scanSessionHistoryForPaging(maxFiles = MAX_FILES): { sessions: SessionInfo[]; sourceLimited: boolean } {
  const scan = scanCatalog(maxFiles);
  return {
    sessions: scan.all.sort((left, right) =>
      right.lastActivityAt - left.lastActivityAt
      || left.agent.localeCompare(right.agent)
      || left.sessionId.localeCompare(right.sessionId)
    ),
    sourceLimited: scan.sourceLimited,
  };
}

function activityForSession(session: SessionInfo): ActivityEntry[] {
  if (session.agent === "claude") return claudeActivity(session);
  if (session.agent === "codex") return codexActivity(session);
  if (session.agent === "cursor") return cursorActivity(session);
  if (session.agent === "grok") return grokActivity(session);
  return [];
}

/**
 * Keep the person's chat first. Newest child rows used to fill the whole
 * window, so a Cursor chat with many Task-tool runs arrived with no root
 * messages and the phone showed only Agent conversations.
 */
export function pickActivityEntries(all: ActivityEntry[], limit: number): ActivityEntry[] {
  if (all.length <= limit) return all;
  const root = all.filter((entry) => !entry.childThreadId);
  const children = all.filter((entry) => entry.childThreadId);
  const pickedRoot = children.length === 0
    ? root.slice(-limit)
    : root.slice(-Math.min(root.length, Math.max(12, Math.ceil((limit * 2) / 3))));
  const newestByThread = new Map<string, ActivityEntry>();
  for (const entry of children) {
    newestByThread.set(entry.childThreadId!, entry);
  }
  const childBudget = Math.max(4, limit - pickedRoot.length);
  const childCrumbs = [...newestByThread.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-childBudget);
  const keptIds = new Set([...pickedRoot, ...childCrumbs].map((entry) => entry.id));
  const extras = all
    .filter((entry) => (entry.mcpServer || entry.skill) && !keptIds.has(entry.id))
    .slice(-limit);
  const byId = new Map<string, ActivityEntry>();
  for (const entry of [...extras, ...childCrumbs, ...pickedRoot]) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function scanSessionActivity(session: SessionInfo): SessionActivity {
  // A Project rule that refused something is part of what happened in this
  // chat, so it is shown there, beside the call it stopped.
  const refusals: ActivityEntry[] = recentProjectDecisions(session.sessionId).map((record) => ({
    id: `decision:${record.at}:${record.toolName}`,
    kind: "status",
    text: record.ruleId
      ? `Blocked by Project rule ${record.ruleId}: ${record.reason}`
      : `Blocked by Project Governance: ${record.reason}`,
    createdAt: record.at,
    toolName: record.toolName,
  }));
  const entries = pickActivityEntries(
    [...activityForSession(session), ...refusals].sort((a, b) => a.createdAt - b.createdAt),
    MAX_ACTIVITY_ENTRIES,
  );
  if (session.state !== "working") {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index]?.kind === "message") {
        entries[index] = { ...entries[index]!, kind: "final" };
        break;
      }
    }
  }
  return {
    type: "session.activity",
    sessionId: session.sessionId,
    agent: session.agent,
    state: session.state,
    entries,
    generatedAt: Date.now(),
  };
}

/** One agent conversation's rows travel on their own, bounded, when asked for. */
export const MAX_THREAD_ENTRIES = 60;

/**
 * Every row of one agent conversation, newest last. The chat's own window
 * keeps a few of each conversation's rows for navigation; opened, the
 * conversation is worth reading whole, and it is read from the transcript
 * on demand rather than carried on every tick.
 */
export function scanThreadActivity(session: SessionInfo, threadId: string): SessionActivity {
  const entries = activityForSession(session)
    .filter((entry) => entry.childThreadId === threadId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-MAX_THREAD_ENTRIES);
  return {
    type: "session.activity",
    sessionId: session.sessionId,
    agent: session.agent,
    state: session.state,
    threadId,
    entries,
    generatedAt: Date.now(),
  };
}

/**
 * MCP/skill/CLI telemetry comes from observations cached during provider scans.
 * Calls without result rows remain explicitly input-only.
 */
export function scanCapabilityUsage(
  sessions: SessionInfo[] = [...scanSessions().sessions, ...scanSessionHistory()],
): CapabilityUsageStatus {
  const candidates: RemoteCapabilityUsageEvent[] = [];
  // Totals count every observation as it streams past; the candidate list is
  // trimmed to a byte budget and can never answer for a whole period.
  const totals = createCapabilityTotals();
  const seenSessions = new Set<string>();
  for (const session of sessions) {
    if (seenSessions.has(session.sessionId)) continue;
    seenSessions.add(session.sessionId);
    const observations =
      session.agent === "claude" ? claudeCapabilityUsage(session)
        : session.agent === "codex" ? codexCapabilityUsage(session)
          : session.agent === "cursor" ? cursorCapabilityUsage(session)
            : session.agent === "grok" ? grokCapabilityUsage(session)
            : [];
    for (const observation of observations) {
      const event = toRemoteCapabilityUsageEvent(observation);
      if (!event) continue;
      totals.add(event);
      rememberCapabilityUsageCandidate(candidates, event);
    }
  }
  return {
    type: "capability.usage.status",
    events: limitCapabilityUsageEvents(candidates),
    totals: totals.rows(),
    generatedAt: Date.now(),
  };
}

/** Bind every local observation to the authenticated relay room before publish. */
export function scopeCapabilityUsageToRoom(
  status: CapabilityUsageStatus,
  rawRoomId: string,
): CapabilityUsageStatus {
  const roomId = rawRoomId.trim();
  if (!roomId || roomId.length > 256) {
    throw new TypeError("invalid capability usage room id");
  }
  const scoped: RemoteCapabilityUsageEvent[] = [];
  for (const event of status.events) {
    const sessionId = event.sessionId?.trim();
    if (!sessionId || sessionId.length > 256) continue;
    scoped.push({
      ...event,
      roomId,
      sessionId,
      deepLinkTarget: { kind: "chat", roomId, sessionId },
    });
  }
  return { ...status, events: limitCapabilityUsageEvents(scoped) };
}
