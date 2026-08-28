/**
 * Cached, provider-aware session catalog.
 *
 * Provider readers parse each bounded JSONL once and retain capability
 * observations beside their session summary. Activity and telemetry therefore
 * do not trigger a second filesystem walk during the monitor publish cycle.
 */
import type {
  ActivityEntry,
  CapabilityUsageStatus,
  RemoteCapabilityUsageEvent,
  SessionActivity,
  SessionInfo,
} from "../../../packages/protocol/schema";
import {
  MAX_ACTIVITY_ENTRIES,
  MAX_ACTIVITY_TEXT,
} from "./sessions/activity-helpers";
import {
  MAX_HISTORY,
  MAX_LIVE,
  TOKEN_WINDOW_HOURS,
  TOKEN_WINDOW_MS,
} from "./sessions/common";
import {
  claudeActivity,
  claudeCapabilityUsage,
  scanClaude,
} from "./sessions/claude";
import {
  codexActivity,
  codexCapabilityUsage,
  scanCodex,
} from "./sessions/codex";
import {
  cursorActivity,
  cursorCapabilityUsage,
  scanCursor,
} from "./sessions/cursor";
import { grokActivity, grokCapabilityUsage, scanGrok } from "./sessions/grok";
import {
  limitCapabilityUsageEvents,
  rememberCapabilityUsageCandidate,
  toRemoteCapabilityUsageEvent,
} from "./sessions/telemetry";
import { createCapabilityTotals } from "./sessions/capability-totals";
import { loadRuntimeConfig } from "./config";
import { timedProviderScan } from "./machine-load/scan-cost";

export { MAX_ACTIVITY_ENTRIES, MAX_ACTIVITY_TEXT, TOKEN_WINDOW_HOURS };

type ProviderScan = ReturnType<typeof scanClaude>;

function emptyScan(): ProviderScan {
  return { sessions: [], tokensRecent: 0 };
}

/**
 * Explicit provider roots isolate fixtures and diagnostics from real user logs.
 * In normal operation (no overrides) every installed provider is scanned.
 */
function providerScans(): ProviderScan[] {
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
      ? timedProviderScan("claude", scanClaude) : emptyScan(),
    enabled.codex && (!isolated || explicit.codex)
      ? timedProviderScan("codex", scanCodex) : emptyScan(),
    enabled.cursor && (!isolated || explicit.cursor)
      ? timedProviderScan("cursor", scanCursor) : emptyScan(),
    enabled.grok && (!isolated || explicit.grok)
      ? timedProviderScan("grok", scanGrok) : emptyScan(),
  ];
}

function sortedUniqueSessions(scans: ProviderScan[]): SessionInfo[] {
  const merged = new Map<string, SessionInfo>();
  for (const session of scans.flatMap((scan) => scan.sessions)) {
    const previous = merged.get(session.sessionId);
    if (!previous || session.lastActivityAt >= previous.lastActivityAt) {
      merged.set(session.sessionId, session);
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
      picked.set(session.sessionId, session);
    }
  }
  for (const session of candidates) {
    if (picked.size >= limit) break;
    picked.set(session.sessionId, session);
  }
  const order = new Map(candidates.map((session, index) => [session.sessionId, index]));
  return [...picked.values()].sort(
    (a, b) => (order.get(a.sessionId) ?? 0) - (order.get(b.sessionId) ?? 0),
  );
}

function scanCatalog(): { all: SessionInfo[]; tokensRecent: number } {
  const scans = providerScans();
  return {
    all: sortedUniqueSessions(scans),
    tokensRecent: scans.reduce((sum, scan) => sum + scan.tokensRecent, 0),
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

function activityForSession(session: SessionInfo): ActivityEntry[] {
  if (session.agent === "claude") return claudeActivity(session);
  if (session.agent === "codex") return codexActivity(session);
  if (session.agent === "cursor") return cursorActivity(session);
  if (session.agent === "grok") return grokActivity(session);
  return [];
}

/**
 * Keep the newest transcript window plus bounded older capability/child rows so
 * one busy subagent cannot erase all sibling navigation and accounting rows.
 */
function pickActivityEntries(all: ActivityEntry[], limit: number): ActivityEntry[] {
  if (all.length <= limit) return all;
  const recent = all.slice(-limit);
  const recentIds = new Set(recent.map((entry) => entry.id));
  const extras = all
    .filter((entry) =>
      (entry.mcpServer || entry.skill || entry.childThreadId) && !recentIds.has(entry.id)
    )
    .slice(-limit);
  if (extras.length === 0) return recent;
  const byId = new Map<string, ActivityEntry>();
  for (const entry of [...extras, ...recent]) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function scanSessionActivity(session: SessionInfo): SessionActivity {
  const entries = pickActivityEntries(activityForSession(session), MAX_ACTIVITY_ENTRIES);
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
