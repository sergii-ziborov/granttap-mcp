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
  TOKEN_WINDOW_HOURS,
} from "./support/common";
import {
  claudeCapabilityUsage,
} from "./scan/claude";
import {
  codexCapabilityUsage,
} from "./scan/codex";
import {
  cursorCapabilityUsage,
} from "./cursor";
import { grokCapabilityUsage } from "./scan/grok";
import { activityForSession } from './session-activity';
export { MAX_THREAD_ENTRIES, scanThreadActivity } from './session-activity';
import {
  limitCapabilityUsageEvents,
  rememberCapabilityUsageCandidate,
  toRemoteCapabilityUsageEvent,
} from "./telemetry";
import { createCapabilityTotals } from "./support/capability-totals";
import { createExecutionSummaries, budgetExecutionSummaries } from './telemetry/execution-summaries';
import { readCodexCapabilityHistory, type NativeCapabilityEvidence } from './native-capability-history';
import { recordedClaudeUsage } from './scan/claude';

export { MAX_ACTIVITY_ENTRIES, MAX_ACTIVITY_TEXT, TOKEN_WINDOW_HOURS };
export { nativeTranscriptRoots, nativeTranscriptSource, restoreNativeTranscriptSource } from "./native-source";

export { scanSessions, scanSessionHistory, scanSessionHistoryForPaging,
  scanSessionsCooperatively, scanSessionHistoryCooperatively } from "./catalog";
import { scanSessions, scanSessionHistory } from "./catalog";

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

/**
 * MCP/skill/CLI telemetry comes from observations cached during provider scans.
 * Calls without result rows remain explicitly input-only.
 */
export function scanCapabilityUsage(
  sessions: SessionInfo[] = [...scanSessions().sessions, ...scanSessionHistory()],
  native?: NativeCapabilityEvidence,
): CapabilityUsageStatus {
  const candidates: RemoteCapabilityUsageEvent[] = [];
  // Totals count every observation as it streams past; the candidate list is
  // trimmed to a byte budget and can never answer for a whole period.
  const totals = createCapabilityTotals();
  const summaries = createExecutionSummaries();
  const seenSessions = new Set<string>();
  for (const session of sessions) {
    const nativeScope = `${session.agent}\0${session.sessionId}`;
    if (seenSessions.has(nativeScope)) continue;
    seenSessions.add(nativeScope);
    const observations =
      session.agent === "claude" ? claudeCapabilityUsage(session)
        : session.agent === "codex" ? codexCapabilityUsage(session)
          : session.agent === "cursor" ? cursorCapabilityUsage(session)
            : session.agent === "grok" ? grokCapabilityUsage(session)
            : [];
    const recorded = session.agent === 'codex' && native?.scopes.includes(session.sessionId);
    const claudeRecorded = session.agent === 'claude' ? recordedClaudeUsage(observations) : undefined;
    const events = observations.map(toRemoteCapabilityUsageEvent).filter(
      (event): event is RemoteCapabilityUsageEvent => event != null
        && !(recorded && event.kind === 'mcp'));
    if (recorded) events.push(...native!.events.filter(event => event.sessionId === session.sessionId));
    for (const converted of events) {
      const event = { ...converted, agent: session.agent };
      if (!claudeRecorded || event.kind === 'cli') {
        totals.add(event);
        summaries.add(event, recorded && event.kind === 'mcp' ? 'native-history' : 'transcript');
      }
      rememberCapabilityUsageCandidate(candidates, event);
    }
    for (const summary of claudeRecorded?.summaries ?? []) summaries.merge(summary);
    for (const total of claudeRecorded?.totals ?? []) totals.merge(total);
  }
  const metadata = { type: "capability.usage.status" as const,
    totals: totals.rows(), generatedAt: Date.now() };
  const executionSummaries = budgetExecutionSummaries(summaries.rows(), metadata);
  const envelope = { ...metadata, ...(executionSummaries.length ? { executionSummaries } : {}) };
  return { ...envelope, events: limitCapabilityUsageEvents(candidates, envelope) };
}

/** Native metadata enrichment runs off the relay event loop. */
export async function scanRecordedCapabilityUsage(sessions: SessionInfo[]): Promise<CapabilityUsageStatus> {
  return scanCapabilityUsage(sessions, await readCodexCapabilityHistory(sessions));
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
  const { events: _events, ...envelope } = status;
  return { ...envelope, events: limitCapabilityUsageEvents(scoped, envelope) };
}
