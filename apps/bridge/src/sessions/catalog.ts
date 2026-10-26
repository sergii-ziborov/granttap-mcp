import type { SessionInfo } from "../../../../packages/protocol/schema";
import { localTaskTransfers, localTransferContinuations } from "../task-transfer";
import { loadRuntimeConfig } from "../config";
import { timedProviderScan, timedProviderScanAsync } from "../machine-load/mcp/scan-cost";
import { scanClaude, scanClaudeCooperatively } from "./scan/claude";
import { scanCodex, scanCodexCooperatively } from "./scan/codex";
import { scanCursor } from "./cursor";
import { scanGrok } from "./scan/grok";
import { MAX_FILES, MAX_HISTORY, MAX_LIVE, TOKEN_WINDOW_MS } from "./support/common";
import { setImmediate } from "node:timers/promises";

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
function providerReaders(maxFiles: number) {
  const enabled = loadRuntimeConfig().providerSettings;
  const explicit = {
    claude: Boolean(process.env.GRANTTAP_CLAUDE_PROJECTS_DIR || process.env.NODVOX_CLAUDE_PROJECTS_DIR),
    codex: Boolean(process.env.GRANTTAP_CODEX_SESSIONS_DIR || process.env.NODVOX_CODEX_SESSIONS_DIR),
    cursor: Boolean(process.env.GRANTTAP_CURSOR_TRANSCRIPTS_DIR || process.env.GRANTTAP_CURSOR_STATE_DB),
    grok: Boolean(process.env.GRANTTAP_GROK_SESSIONS_DIR || process.env.GROK_HOME),
  };
  const isolated = Object.values(explicit).some(Boolean);
  const cooperative = { claude: scanClaudeCooperatively, codex: scanCodexCooperatively,
    cursor: async (limit: number) => scanCursor(limit), grok: async (limit: number) => scanGrok(limit) };
  return Object.entries({ claude: scanClaude, codex: scanCodex, cursor: scanCursor, grok: scanGrok })
    .map(([agent, read]) => {
      const key = agent as keyof typeof explicit;
      return { agent, read: () => read(maxFiles), cooperative: () => cooperative[key](maxFiles),
        enabled: enabled[key] && (!isolated || explicit[key]) };
    });
}

function providerScans(maxFiles = MAX_FILES): ProviderScan[] {
  return providerReaders(maxFiles).map(reader => reader.enabled
    ? timedProviderScan(reader.agent, reader.read) : emptyScan());
}

async function cooperativeProviderScans(maxFiles = MAX_FILES): Promise<ProviderScan[]> {
  const scans: ProviderScan[] = [];
  for (const reader of providerReaders(maxFiles)) {
    await setImmediate();
    scans.push(reader.enabled ? await timedProviderScanAsync(reader.agent, reader.cooperative) : emptyScan());
  }
  return scans;
}

function sortedUniqueSessions(sessions: SessionInfo[]): SessionInfo[] {
  const merged = new Map<string, SessionInfo>();
  for (const session of sessions) {
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

function catalogFromScans(scans: ProviderScan[]) {
  const native = sortedUniqueSessions(scans.flatMap((scan) => scan.sessions));
  // Prepared transfers replace native ids; rank their native activity before
  // the bounded live/history windows, rather than appending them after older chats.
  const sessions = sortedUniqueSessions(localTaskTransfers().catalog(native));
  return {
    all: sessions.map(session => ({ ...session,
      transfer: localTransferContinuations().notice(session.sessionId) })),
    tokensRecent: scans.reduce((sum, scan) => sum + scan.tokensRecent, 0),
    sourceLimited: scans.some((scan) => scan.sourceLimited === true),
  };
}

function scanCatalog(maxFiles = MAX_FILES) {
  return catalogFromScans(providerScans(maxFiles));
}

export async function scanSessionsCooperatively() {
  return liveCatalog(catalogFromScans(await cooperativeProviderScans()));
}

export async function scanSessionHistoryCooperatively(): Promise<SessionInfo[]> {
  return historyCatalog(catalogFromScans(await cooperativeProviderScans()).all);
}

export function scanSessions(): { sessions: SessionInfo[]; tokensRecent: number } {
  return liveCatalog(scanCatalog());
}

function liveCatalog({ all, tokensRecent }: { all: SessionInfo[]; tokensRecent: number }) {
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
  return historyCatalog(scanCatalog().all);
}

function historyCatalog(sessions: SessionInfo[]): SessionInfo[] {
  return pickWithReserve(sessions, Math.min(MAX_HISTORY, 200), 40);
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

