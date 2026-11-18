import { statSync } from "node:fs";
import { basename } from "node:path";
import type { ApprovalRequest, SessionInfo } from "../../../../packages/protocol/schema";
import { observeSessionExecution } from "../session-catalog/observed-state";
import { nativeTranscriptSource } from "../sessions/native-source";
import { claudeChildLogPaths, claudeLogPath } from "../sessions/scan/claude/shared";
import { activityForSession } from "../sessions/session-activity";
import { localTaskTransfers } from "../task-transfer";
import { pulseName } from "./classification/tools";
import { claudeObservation } from "./readers/claude";
import { codexObservation } from "./readers/codex";
import { entriesObservation } from "./readers/entries";
import { emptyObservation, tailLines, type ObservedCall, type Observation } from "./readers/shared";

/** How much of a chat's own file is read: its recent work, never its whole history. */
const ROOT_BYTES = 768 * 1024;
const CHILD_BYTES = 256 * 1024;
const MAX_CHILDREN = 3;
const CHILD_RECENT_MS = 15 * 60_000;
const MAX_APPROVALS = 16;

type Source = { revision: string; read: () => Observation };

const fileRevision = (path: string): string => {
  try {
    const stat = statSync(path);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch { return "missing"; }
};

function recentChildren(path: string, sessionId: string, now: number): string[] {
  return claudeChildLogPaths(path, sessionId).filter(child => {
    try { return now - statSync(child).mtimeMs <= CHILD_RECENT_MS; } catch { return false; }
  }).slice(0, MAX_CHILDREN);
}

/**
 * A Claude chat discovery has not indexed is looked for across every project folder; that walk is
 * done at most once a minute for a chat found, and every ten seconds for one not written yet.
 */
const LOOKUP_MS = 60_000;
const MISS_MS = 10_000;
const lookups = new Map<string, { path?: string; at: number }>();

function claudeFallback(sessionId: string, now: number): string | undefined {
  const known = lookups.get(sessionId);
  if (known && now - known.at < (known.path ? LOOKUP_MS : MISS_MS)) return known.path;
  const path = claudeLogPath(sessionId);
  lookups.delete(sessionId);
  lookups.set(sessionId, { path, at: now });
  while (lookups.size > 16) lookups.delete(lookups.keys().next().value!);
  return path;
}

/** Where a chat's work is recorded, and the cheap revision that says whether it changed. */
function sourceFor(session: SessionInfo, now: number): Source | undefined {
  const native = localTaskTransfers().nativeSession(session);
  if (native.agent === "claude" || native.agent === "codex") {
    const path = nativeTranscriptSource(native) ?? (native.agent === "claude" ? claudeFallback(native.sessionId, now) : undefined);
    if (!path) return undefined;
    const children = native.agent === "claude" ? recentChildren(path, native.sessionId, now) : [];
    return {
      revision: [path, ...children].map(file => `${file}\0${fileRevision(file)}`).join("\u0001"),
      read: () => native.agent === "codex" ? codexObservation(tailLines(path, ROOT_BYTES) ?? [])
        : claudeObservation(tailLines(path, ROOT_BYTES) ?? [], children.map(child => ({
          agentKey: basename(child, ".jsonl"), lines: tailLines(child, CHILD_BYTES) ?? [] }))),
    };
  }
  if (native.agent !== "cursor" && native.agent !== "grok") return undefined;
  const observed = observeSessionExecution(session);
  return {
    revision: observed?.revision ?? `${session.lastActivityAt}:${session.state}`,
    read: () => entriesObservation(session, activityForSession(observed?.session ?? session)),
  };
}

/**
 * A chat's observation, read again only when its records changed. The hook's pending approvals for
 * the chat stand on the Hooks station; the catalog's subagents still at work circle Agents.
 */
export function liveMapObserver(options: { pending: () => ApprovalRequest[]; now?: () => number }) {
  const cache = new Map<string, { revision: string; observation: Observation }>();
  const approvals = new Map<string, Map<string, ObservedCall>>();
  const now = options.now ?? Date.now;

  const hooked = (session: SessionInfo, pending: ApprovalRequest[], at: number): ObservedCall[] => {
    const native = localTaskTransfers().nativeSession(session).sessionId;
    const seen = approvals.get(session.sessionId) ?? new Map<string, ObservedCall>();
    approvals.set(session.sessionId, seen);
    const open = new Set<string>();
    for (const request of pending) {
      if (request.sessionId !== session.sessionId && request.sessionId !== native) continue;
      open.add(request.requestId);
      if (!seen.has(request.requestId)) seen.set(request.requestId, { key: `approval:${request.requestId}`,
        station: "hooks", name: pulseName(request.tool), startedAt: request.createdAt, status: "run", mark: "approval" });
    }
    for (const [id, call] of seen) {
      if (!open.has(id) && call.status === "run") Object.assign(call, { status: "ok", endedAt: at });
    }
    while (seen.size > MAX_APPROVALS) seen.delete(seen.keys().next().value!);
    return [...seen.values()];
  };

  return (session: SessionInfo): Observation => {
    const at = now();
    const source = sourceFor(session, at);
    let observation = emptyObservation();
    if (source) {
      const hit = cache.get(session.sessionId);
      observation = hit?.revision === source.revision ? hit.observation : source.read();
      cache.delete(session.sessionId);
      cache.set(session.sessionId, { revision: source.revision, observation });
      while (cache.size > 8) cache.delete(cache.keys().next().value!);
    }
    const children = (session.childThreads ?? []).filter(child => child.state === "working").map(child => child.threadId);
    const calls = [...observation.calls, ...hooked(session, options.pending(), at)].sort((a, b) => a.startedAt - b.startedAt);
    return { ...observation, calls, agents: [...new Set([...observation.agents, ...children])].slice(0, 12) };
  };
}
