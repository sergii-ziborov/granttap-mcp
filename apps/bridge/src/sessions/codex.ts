import { recordObservedWrite, writtenPaths } from "../mesh/observed-writes";
/**
 * Codex session logs:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *   `event_msg` entries of type `token_count` carry
 *   `total_token_usage` and `last_token_usage` outright.
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type {
  ActivityEntry,
  ChildThreadInfo,
  SessionInfo,
} from "../../../../packages/protocol/schema";
import {
  codexSessionsRoot,
  recentLogs,
  safeParse,
  stateFor,
  TOKEN_WINDOW_MS,
  ts,
  type Scan,
} from "./common";
import {
  classifyTool,
  estimateTokens,
  pushEntry,
  toolSummary,
  visibleUserText,
} from "./activity-helpers";
import {
  aggregateChildThreads,
  childEntryFields,
  childTitle,
} from "./child-threads";
import { codexHeadRequest } from "./codex-head";
import {
  activityTelemetry,
  observeCapability,
  pendingCapabilityObservation,
  rememberCapabilityObservation,
  rememberPendingCapabilityCall,
  type CapabilityObservation,
  type PendingCapabilityTool,
} from "./telemetry";

type CachedCodexSummary = {
  mtimeMs: number;
  size: number;
  session: SessionInfo;
  tokensSession: number;
  observations: CapabilityObservation[];
  child?: CodexChildSource;
};

type CodexChildSource = {
  parentThreadId: string;
  depth: number;
  agentPath?: string;
  agentName?: string;
};

type CodexCandidate = {
  file: string;
  session: SessionInfo;
  observations: CapabilityObservation[];
  child?: CodexChildSource;
};

type CodexActivitySource = {
  path: string;
  child?: ChildThreadInfo;
};

const codexSummaryCache = new Map<string, CachedCodexSummary>();
const codexLogPathBySession = new Map<string, string>();
const codexActivitySourcesBySession = new Map<string, CodexActivitySource[]>();
const codexAggregatedObservationsBySession = new Map<string, CapabilityObservation[]>();

const CODEX_SUMMARY_HEAD_BYTES = 128 * 1024;
const CODEX_SUMMARY_TAIL_BYTES = 512 * 1024;
const CODEX_ACTIVITY_HEAD_BYTES = 256 * 1024;
const CODEX_ACTIVITY_TAIL_BYTES = 2 * 1024 * 1024;

/**
 * Codex rollouts may contain a single screenshot/tool-result line larger than a
 * gigabyte. A catalog refresh must never materialize that whole file. Preserve
 * complete JSONL rows from the metadata head and recent tail under a hard cap.
 */
function readCodexLogWindow(
  path: string,
  headBytes = CODEX_SUMMARY_HEAD_BYTES,
  tailBytes = CODEX_SUMMARY_TAIL_BYTES,
): string[] {
  const size = statSync(path).size;
  if (size <= headBytes + tailBytes) return readFileSync(path, "utf8").split("\n");
  const fd = openSync(path, "r");
  try {
    const head = Buffer.allocUnsafe(headBytes);
    const headRead = readSync(fd, head, 0, headBytes, 0);
    let headText = head.subarray(0, headRead).toString("utf8");
    const headBreak = headText.lastIndexOf("\n");
    headText = headBreak >= 0 ? headText.slice(0, headBreak + 1) : "";

    const tailStart = Math.max(0, size - tailBytes - 1);
    const tailLength = size - tailStart;
    const tail = Buffer.allocUnsafe(tailLength);
    const tailRead = readSync(fd, tail, 0, tailLength, tailStart);
    let tailText = tail.subarray(0, tailRead).toString("utf8");
    if (tailStart > 0) {
      const tailBreak = tailText.indexOf("\n");
      tailText = tailBreak >= 0 ? tailText.slice(tailBreak + 1) : "";
    }
    return `${headText}${tailText}`.split("\n");
  } finally {
    closeSync(fd);
  }
}

function codexChildSource(meta: any): CodexChildSource | undefined {
  const spawn = meta?.source?.subagent?.thread_spawn;
  const parentThreadId =
    typeof spawn?.parent_thread_id === "string" ? spawn.parent_thread_id.trim() : "";
  if (!parentThreadId) return undefined;
  return {
    parentThreadId,
    depth: Math.max(1, Math.min(16, Number(spawn.depth) || 1)),
    agentPath: typeof spawn.agent_path === "string" ? spawn.agent_path : undefined,
    agentName: typeof spawn.agent_nickname === "string" ? spawn.agent_nickname : undefined,
  };
}

/** Exclude the repeatedly-counted cached prompt from session spend. */
function effectiveCodexUsage(usage: any): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const total = usage.total_tokens;
  if (typeof total !== "number" || !Number.isFinite(total)) return undefined;
  const cached =
    typeof usage.cached_input_tokens === "number" && Number.isFinite(usage.cached_input_tokens)
      ? usage.cached_input_tokens
      : 0;
  return Math.max(0, total - cached);
}

export function scanCodex(): Scan {
  const root = codexSessionsRoot();
  const files = recentLogs(root, 5);
  const activeFiles = new Set(files);
  const seenSessionIds = new Set<string>();
  const candidates: CodexCandidate[] = [];
  codexLogPathBySession.clear();
  codexActivitySourcesBySession.clear();
  codexAggregatedObservationsBySession.clear();

  for (const file of files) {
    let fileStat;
    try {
      fileStat = statSync(file);
    } catch {
      continue;
    }
    const cached = codexSummaryCache.get(file);
    if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
      const session = {
        ...cached.session,
        state: stateFor(cached.session.lastActivityAt),
      };
      if (seenSessionIds.has(session.sessionId)) continue;
      seenSessionIds.add(session.sessionId);
      candidates.push({ file, session, observations: cached.observations, child: cached.child });
      continue;
    }
    let lines: string[];
    try {
      lines = readCodexLogWindow(file);
    } catch {
      continue;
    }
    let sessionId = "";
    let cwd: string | undefined;
    let branch: string | undefined;
    let model: string | undefined;
    let title: string | undefined;
    let summary: string | undefined;
    let accessLevel: SessionInfo["accessLevel"];
    let child: CodexChildSource | undefined;
    let startedAt = 0;
    let lastActivityAt = 0;
    let tokensSession = 0;
    let tokensLastTurn = 0;
    let contextTokensUsed: number | undefined;
    let contextWindow: number | undefined;

    for (const line of lines) {
      if (!line) continue;
      const d = safeParse(line);
      if (!d) continue;

      const t = ts(d.timestamp);
      if (t) {
        if (!startedAt || t < startedAt) startedAt = t;
        if (t > lastActivityAt) lastActivityAt = t;
      }

      if (d.type === "session_meta") {
        const p = d.payload ?? d;
        if (p?.id) sessionId = String(p.id);
        if (p?.cwd) cwd = String(p.cwd);
        if (p?.model) model = String(p.model);
        if (p?.git?.branch) branch = String(p.git.branch);
        if (typeof p?.title === "string" && p.title.trim()) title = p.title.trim().slice(0, 120);
        child = codexChildSource(p);
      }

      if (d.type === "turn_context") {
        if (d.payload?.model) model = String(d.payload.model);
        const sandbox = d.payload?.sandbox_policy?.type;
        if (sandbox === "read-only") accessLevel = "read-only";
        if (sandbox === "workspace-write") accessLevel = "workspace";
        if (sandbox === "danger-full-access") accessLevel = "full";
      }

      if (!title && d.type === "event_msg" && d.payload?.type === "user_message") {
        title = childTitle(visibleUserText(d.payload.message ?? d.payload.text));
      }
      if (
        !title &&
        d.type === "response_item" &&
        d.payload?.type === "message" &&
        d.payload?.role === "user" &&
        Array.isArray(d.payload.content)
      ) {
        const visible = d.payload.content
          .filter((block: any) => block?.type === "input_text" || block?.type === "text")
          .map((block: any) => visibleUserText(block.text))
          .filter(Boolean)
          .join("\n");
        if (visible) title = childTitle(visible);
      }

      if (d.type === "event_msg" && d.payload?.type === "agent_message") {
        summary = childTitle(d.payload.message ?? d.payload.text)?.slice(0, 180);
      }
      if (
        d.type === "response_item" &&
        d.payload?.type === "message" &&
        d.payload?.role === "assistant" &&
        Array.isArray(d.payload.content)
      ) {
        for (const block of d.payload.content) {
          if (["output_text", "text"].includes(block?.type) && typeof block.text === "string") {
            summary = childTitle(block.text)?.slice(0, 180);
          }
        }
      }

      // Codex reports both totals and the last turn directly.
      if (d.type === "event_msg" && d.payload?.type === "token_count") {
        const info = d.payload.info ?? {};
        const total = effectiveCodexUsage(info.total_token_usage);
        const last = effectiveCodexUsage(info.last_token_usage);
        if (total != null) tokensSession = total;
        if (last != null) tokensLastTurn = last;
        const input = info.last_token_usage?.input_tokens;
        if (typeof input === "number" && Number.isFinite(input)) contextTokensUsed = input;
        const window = info.model_context_window;
        if (typeof window === "number" && Number.isFinite(window)) contextWindow = window;
      }
    }

    if (!title) title = childTitle(codexHeadRequest(file)?.text);
    lastActivityAt = Math.max(lastActivityAt, fileStat.mtimeMs);
    startedAt ||= fileStat.birthtimeMs || lastActivityAt;
    if (!sessionId) sessionId = file.split("/").pop()?.replace(".jsonl", "") ?? "codex";
    const session: SessionInfo = {
      sessionId,
      agent: "codex",
      title,
      cwd,
      branch,
      model,
      summary,
      accessLevel,
      state: stateFor(lastActivityAt),
      startedAt: startedAt || lastActivityAt,
      lastActivityAt,
      tokensSession,
      tokensLastTurn,
      contextTokensUsed,
      contextWindow,
    };
    const observations = codexCapabilityUsage(session, lines);
    codexSummaryCache.set(file, {
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
      session,
      tokensSession,
      observations,
      child,
    });
    if (seenSessionIds.has(sessionId)) continue;
    seenSessionIds.add(sessionId);
    candidates.push({ file, session, observations, child });
  }
  for (const file of codexSummaryCache.keys()) {
    if (!activeFiles.has(file)) codexSummaryCache.delete(file);
  }
  const byId = new Map(candidates.map((candidate) => [candidate.session.sessionId, candidate]));
  const rootFor = (candidate: CodexCandidate): string | undefined => {
    let current = candidate;
    const visited = new Set<string>([candidate.session.sessionId]);
    while (current.child) {
      const parentId = current.child.parentThreadId;
      if (visited.has(parentId)) return undefined;
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) {
        // A depth-one record names the real top-level thread even if that older
        // rollout fell outside the bounded file window. Deeper orphans fail closed.
        return current.child.depth === 1 ? parentId : undefined;
      }
      current = parent;
    }
    return current.session.sessionId;
  };

  const childrenByRoot = new Map<string, CodexCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.child) continue;
    const rootId = rootFor(candidate);
    if (!rootId) continue;
    const children = childrenByRoot.get(rootId) ?? [];
    children.push(candidate);
    childrenByRoot.set(rootId, children);
  }

  const roots = candidates.filter((candidate) => !candidate.child);
  const rootIds = new Set(roots.map((candidate) => candidate.session.sessionId));
  for (const [rootId, children] of childrenByRoot) {
    if (rootIds.has(rootId) || children.length === 0) continue;
    const latest = children.reduce((a, b) =>
      b.session.lastActivityAt >= a.session.lastActivityAt ? b : a
    );
    roots.push({
      file: "",
      session: {
        sessionId: rootId,
        agent: "codex",
        // Keep an explicitly named parent row reachable when the older root
        // rollout fell outside MAX_FILES. The child itself still never becomes
        // a top-level session.
        title:
          latest.session.title ??
          childTitle(latest.child?.agentPath?.split("/").filter(Boolean).at(-1)) ??
          "Agent conversation",
        cwd: latest.session.cwd,
        branch: latest.session.branch,
        model: latest.session.model,
        summary: latest.session.summary,
        accessLevel: latest.session.accessLevel,
        state: "idle",
        startedAt: latest.session.startedAt,
        lastActivityAt: 0,
        tokensSession: 0,
        tokensLastTurn: 0,
        contextTokensUsed: latest.session.contextTokensUsed,
        contextWindow: latest.session.contextWindow,
      },
      observations: [],
    });
    rootIds.add(rootId);
  }

  let tokensRecent = 0;
  const sessions: SessionInfo[] = [];
  for (const rootCandidate of roots) {
    const rootId = rootCandidate.session.sessionId;
    const descendants = childrenByRoot.get(rootId) ?? [];
    const childThreads: ChildThreadInfo[] = descendants.map((candidate) => ({
      threadId: candidate.session.sessionId,
      parentThreadId: candidate.child!.parentThreadId,
      title:
        candidate.session.title ??
        childTitle(candidate.child!.agentPath?.split("/").filter(Boolean).at(-1)),
      agentName: childTitle(candidate.child!.agentName),
      depth: candidate.child!.depth,
      state: candidate.session.state,
      startedAt: candidate.session.startedAt,
      lastActivityAt: candidate.session.lastActivityAt,
      tokensSession: candidate.session.tokensSession,
      tokensLastTurn: candidate.session.tokensLastTurn,
    }));
    const session = aggregateChildThreads(rootCandidate.session, childThreads);
    const childById = new Map(session.childThreads?.map((child) => [child.threadId, child]));
    const activitySources: CodexActivitySource[] = [];
    if (rootCandidate.file) {
      activitySources.push({ path: rootCandidate.file });
      codexLogPathBySession.set(rootId, rootCandidate.file);
    }
    for (const candidate of descendants) {
      activitySources.push({
        path: candidate.file,
        child:
          childById.get(candidate.session.sessionId) ?? {
            threadId: candidate.session.sessionId,
            parentThreadId: candidate.child!.parentThreadId,
            title: candidate.session.title,
            agentName: candidate.child!.agentName,
            depth: candidate.child!.depth,
            state: candidate.session.state,
            startedAt: candidate.session.startedAt,
            lastActivityAt: candidate.session.lastActivityAt,
            tokensSession: candidate.session.tokensSession,
            tokensLastTurn: candidate.session.tokensLastTurn,
          },
      });
    }
    activitySources.sort((a, b) => {
      const aa = a.child?.startedAt ?? rootCandidate.session.startedAt;
      const bb = b.child?.startedAt ?? rootCandidate.session.startedAt;
      return aa - bb;
    });
    codexActivitySourcesBySession.set(rootId, activitySources);

    const observations: CapabilityObservation[] = [];
    for (const candidate of [rootCandidate, ...descendants]) {
      for (const observation of candidate.observations) {
        rememberCapabilityObservation(observations, {
          ...observation,
          sessionId: rootId,
        });
      }
    }
    codexAggregatedObservationsBySession.set(rootId, observations);
    if (Date.now() - session.lastActivityAt <= TOKEN_WINDOW_MS) {
      tokensRecent += session.tokensSession;
    }
    sessions.push(session);
  }
  return { sessions, tokensRecent };
}

function codexLogLines(sessionId: string): string[] | undefined {
  const indexed = codexLogPathBySession.get(sessionId);
  if (indexed) {
    try {
      return readCodexLogWindow(
        indexed,
        CODEX_ACTIVITY_HEAD_BYTES,
        CODEX_ACTIVITY_TAIL_BYTES,
      );
    } catch {
      codexLogPathBySession.delete(sessionId);
    }
  }
  for (const file of recentLogs(codexSessionsRoot(), 5)) {
    try {
      const candidate = readCodexLogWindow(file);
      if (candidate.some((line) => {
        const row = safeParse(line);
        return row?.type === "session_meta" &&
          String(row.payload?.id ?? row.id ?? "") === sessionId;
      })) {
        return candidate;
      }
    } catch {
      // Keep looking through the bounded recent-file set.
    }
  }
  return undefined;
}

function cachedCodexCapabilityUsage(
  sessionId: string,
): CapabilityObservation[] | undefined {
  const file = codexLogPathBySession.get(sessionId);
  if (!file) return undefined;
  const cached = codexSummaryCache.get(file);
  if (!cached || cached.session.sessionId !== sessionId) return undefined;
  try {
    const stat = statSync(file);
    if (stat.mtimeMs !== cached.mtimeMs || stat.size !== cached.size) return undefined;
  } catch {
    return undefined;
  }
  return cached.observations;
}

function codexToolInput(payload: any): unknown {
  let input: unknown = payload.arguments ?? payload.input ?? payload.action;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      // Retain the compact raw form.
    }
  }
  return input;
}

function nestedMcpTools(input: unknown): Array<{ toolName: string; server: string }> {
  const source = typeof input === "string"
    ? input
    : (() => {
        try { return JSON.stringify(input) ?? ""; } catch { return ""; }
      })();
  const out: Array<{ toolName: string; server: string }> = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(/\btools\.(mcp__([A-Za-z0-9_-]+)__[A-Za-z0-9_-]+)\s*\(/g)) {
    const toolName = match[1]!;
    if (seen.has(toolName)) continue;
    seen.add(toolName);
    out.push({ toolName, server: match[2]! });
    if (out.length >= 32) break;
  }
  return out;
}

/** Pair Codex calls/results for MCP, skill, and bounded CLI analytics. */
export function codexCapabilityUsage(
  session: SessionInfo,
  lines?: string[],
): CapabilityObservation[] {
  if (!lines) {
    const aggregated = codexAggregatedObservationsBySession.get(session.sessionId);
    if (aggregated) return aggregated;
    const cached = cachedCodexCapabilityUsage(session.sessionId);
    if (cached) return cached;
    lines = codexLogLines(session.sessionId);
  }
  if (!lines) return [];
  const pending = new Map<string, PendingCapabilityTool>();
  const nestedByCall = new Map<string, Array<{ toolName: string; server: string }>>();
  const out: CapabilityObservation[] = [];

  lines.forEach((line, index) => {
    const row = safeParse(line);
    if (!row || row.type !== "response_item") return;
    const payload = row.payload ?? {};
    const rowAt = ts(row.timestamp);
    if (["function_call", "custom_tool_call", "local_shell_call"].includes(payload.type)) {
      const callId = String(payload.call_id ?? payload.id ?? `${rowAt}:${index}`);
      const item: PendingCapabilityTool = {
        sourceId: `${session.sessionId}:${callId}`,
        sessionId: session.sessionId,
        toolName: String(payload.name ?? payload.type),
        input: codexToolInput(payload),
        createdAt: rowAt || session.lastActivityAt,
        cwd: session.cwd ?? undefined,
      };
      for (const path of writtenPaths(item.toolName, item.input)) {
        recordObservedWrite(session.sessionId, path, item.createdAt);
      }
      const nested = nestedMcpTools(item.input);
      if (nested.length > 0) nestedByCall.set(callId, nested);
      if (payload.type === "local_shell_call") {
        const observation = pendingCapabilityObservation(item);
        if (observation) rememberCapabilityObservation(out, observation);
        return;
      }
      if (pendingCapabilityObservation(item) || nested.length > 0) {
        rememberPendingCapabilityCall(pending, callId, item);
      }
      return;
    }
    if (!["function_call_output", "custom_tool_call_output"].includes(payload.type)) {
      return;
    }
    const callId = String(payload.call_id ?? payload.id ?? "");
    const item = pending.get(callId);
    if (!item) return;
    const observation =
      observeCapability(
        item,
        payload.output ?? payload.content ?? payload.result,
        rowAt || item.createdAt,
        undefined,
        "codex",
      ) ?? pendingCapabilityObservation(item);
    const nested = nestedByCall.get(callId) ?? [];
    // `functions.exec` is only an orchestrator when its source names nested
    // MCP calls. Count those concrete calls, not the wrapper as a second CLI
    // operation with the same input and output budget.
    if (observation && nested.length === 0) rememberCapabilityObservation(out, observation);
    if (nested.length > 0) {
      const total = Math.min(
        100_000,
        Math.max(1, estimateTokens(item.input) + estimateTokens(payload.output ?? payload.content ?? payload.result)),
      );
      const perCapability = Math.max(1, Math.ceil(total / nested.length));
      const resultAt = rowAt || item.createdAt;
      for (const [nestedIndex, tool] of nested.entries()) {
        rememberCapabilityObservation(out, {
          sourceId: `${item.sourceId}:nested:${nestedIndex}`,
          sessionId: item.sessionId,
          toolName: tool.toolName,
          mcpServer: tool.server,
          createdAt: item.createdAt,
          outcome: observation?.outcome ?? "unknown",
          errorClass: observation?.errorClass,
          estimatedContextTokens: perCapability,
          durationMs: resultAt >= item.createdAt
            ? Math.min(60 * 60_000, resultAt - item.createdAt)
            : undefined,
        });
      }
    }
    pending.delete(callId);
    nestedByCall.delete(callId);
  });

  for (const [callId, item] of pending) {
    const observation = pendingCapabilityObservation(item);
    const nested = nestedByCall.get(callId) ?? [];
    if (observation && nested.length === 0) rememberCapabilityObservation(out, observation);
    const perCapability = Math.max(1, Math.ceil(estimateTokens(item.input) / Math.max(1, nested.length)));
    for (const [nestedIndex, tool] of nested.entries()) {
      rememberCapabilityObservation(out, {
        sourceId: `${item.sourceId}:nested:${nestedIndex}`,
        sessionId: item.sessionId,
        toolName: tool.toolName,
        mcpServer: tool.server,
        createdAt: item.createdAt,
        outcome: "unknown",
        estimatedContextTokens: perCapability,
      });
    }
  }
  return out;
}

function appendCodexActivity(
  out: ActivityEntry[],
  seen: Set<string>,
  session: SessionInfo,
  lines: string[],
  observations: Map<string, CapabilityObservation>,
  child?: ChildThreadInfo,
): void {
  const sourceThreadId = child?.threadId ?? session.sessionId;
  const childFields = child ? childEntryFields(child) : {};
  const entryId = (createdAt: number, ordinal: number): string | undefined =>
    child ? `${sourceThreadId}:${createdAt}:${ordinal}` : undefined;
  lines.forEach((line, index) => {
    const d = safeParse(line);
    if (!d) return;
    const p = d.payload ?? {};
    const createdAt = ts(d.timestamp) || session.lastActivityAt;
    if (d.type === "event_msg" && p.type === "user_message") {
      pushEntry(
        out, seen, session.sessionId, "user", p.message ?? p.text, createdAt, index,
        childFields, entryId(createdAt, index),
      );
      return;
    }
    if (d.type === "event_msg" && p.type === "agent_message") {
      pushEntry(
        out, seen, session.sessionId, "message", p.message ?? p.text, createdAt, index,
        childFields, entryId(createdAt, index),
      );
      return;
    }
    if (d.type !== "response_item") return;
    if (p.type === "message" && p.role === "user" && Array.isArray(p.content)) {
      p.content.forEach((block: any, blockIndex: number) => {
        if (block?.type === "input_text" || block?.type === "text") {
          const ordinal = index * 100 + blockIndex;
          pushEntry(
            out, seen, session.sessionId, "user", block.text, createdAt, ordinal,
            childFields, entryId(createdAt, ordinal),
          );
        }
      });
    } else if (p.type === "message" && p.role === "assistant" && Array.isArray(p.content)) {
      p.content.forEach((block: any, blockIndex: number) => {
        if (block?.type === "output_text" || block?.type === "text") {
          const ordinal = index * 100 + blockIndex;
          pushEntry(
            out, seen, session.sessionId, "message", block.text, createdAt, ordinal,
            childFields, entryId(createdAt, ordinal),
          );
        }
      });
    } else if (["function_call", "custom_tool_call", "local_shell_call"].includes(p.type)) {
      const args = codexToolInput(p);
      const toolName = String(p.name ?? p.type);
      const callId = String(p.call_id ?? p.id ?? `${createdAt}:${index}`);
      const sourceId = `${sourceThreadId}:${callId}`;
      const pending: PendingCapabilityTool = {
        sourceId,
        sessionId: session.sessionId,
        toolName,
        input: args,
        createdAt,
        cwd: session.cwd ?? undefined,
      };
      const observation =
        observations.get(sourceId) ?? pendingCapabilityObservation(pending);
      const classified = classifyTool(toolName, args);
      pushEntry(
        out,
        seen,
        session.sessionId,
        "tool",
        toolSummary(toolName, args),
        createdAt,
        index,
        {
          ...childFields,
          ...classified,
          ...(observation
            ? activityTelemetry(observation)
            : { estimatedContextTokens: estimateTokens(args) }),
        },
        observation ? sourceId : entryId(createdAt, index),
      );
    }
  });
}

export function codexActivity(session: SessionInfo): ActivityEntry[] {
  let sources = codexActivitySourcesBySession.get(session.sessionId) ?? [];
  if (sources.length === 0) {
    const path = codexLogPathBySession.get(session.sessionId);
    if (path) sources = [{ path }];
  }
  if (sources.length === 0) {
    const lines = codexLogLines(session.sessionId);
    if (!lines) return [];
    const observations = new Map(
      codexCapabilityUsage(session, lines).map((item) => [item.sourceId, item]),
    );
    const out: ActivityEntry[] = [];
    appendCodexActivity(out, new Set<string>(), session, lines, observations);
    return out;
  }
  const observations = new Map(
    codexCapabilityUsage(session).map((item) => [item.sourceId, item]),
  );
  const out: ActivityEntry[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const head = codexHeadRequest(source.path);
    if (head) {
      const createdAt = head.createdAt || session.startedAt;
      const childFields = source.child ? childEntryFields(source.child) : {};
      pushEntry(
        out, seen, session.sessionId, "user", head.text, createdAt, -1,
        childFields,
        source.child ? `${source.child.threadId}:${createdAt}:-1` : undefined,
      );
    }
    let lines: string[];
    try {
      lines = readCodexLogWindow(
        source.path,
        CODEX_ACTIVITY_HEAD_BYTES,
        CODEX_ACTIVITY_TAIL_BYTES,
      );
    } catch {
      continue;
    }
    appendCodexActivity(out, seen, session, lines, observations, source.child);
  }
  // V8 sort is stable: preserve transcript/source order when providers stamp a
  // whole batch with the same millisecond. Source ids are not chronological.
  return out.sort((a, b) => a.createdAt - b.createdAt);
}
