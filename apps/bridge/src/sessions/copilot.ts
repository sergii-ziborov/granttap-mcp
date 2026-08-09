/**
 * GitHub Copilot CLI/agent sessions:
 *   ~/.copilot/session-state/<sessionId>/events.jsonl
 */
import { basename, dirname } from "node:path";
import { readFileSync, statSync } from "node:fs";
import type {
  ActivityEntry,
  ChildThreadInfo,
  SessionInfo,
} from "../../../../packages/protocol/schema";
import {
  copilotSessionsRoot,
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
  normalizeMcpServerName,
  pushEntry,
  toolSummary,
} from "./activity-helpers";
import {
  aggregateChildThreads,
  childEntryFields,
  childTitle,
} from "./child-threads";
import {
  observeCapability,
  pendingCapabilityObservation,
  rememberCapabilityObservation,
  rememberPendingCapabilityCall,
  type CapabilityObservation,
  type PendingCapabilityTool,
} from "./telemetry";

type CopilotSummaryCache = {
  mtimeMs: number;
  size: number;
  session: SessionInfo;
  observations: CapabilityObservation[];
};

const copilotSummaryCache = new Map<string, CopilotSummaryCache>();
let copilotLogPathBySession = new Map<string, string>();

function copilotCapabilityToolName(rawName: string, input: unknown): string {
  const name = rawName.trim();
  if (
    /^(CallMcpTool|GetMcpTools)$/i.test(name) &&
    input &&
    typeof input === "object"
  ) {
    const meta = input as Record<string, unknown>;
    const server =
      typeof meta.server === "string" ? normalizeMcpServerName(meta.server) : "";
    const tool =
      typeof meta.toolName === "string" && meta.toolName.trim()
        ? meta.toolName.trim()
        : name;
    if (server) return `mcp__${server}__${tool}`;
  }
  // Copilot CLI flattens MCP tools as `<server>-<tool>`. The explicit
  // `mcp[-server]` marker avoids classifying ordinary hyphenated built-ins.
  const flattened = /^(.+?mcp(?:-server)?)[-_.](.+)$/i.exec(name);
  if (flattened?.[1] && flattened[2]) {
    return `mcp__${normalizeMcpServerName(flattened[1])}__${flattened[2]}`;
  }
  return name;
}

function copilotToolInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function copilotCapabilityUsageFromRows(
  session: SessionInfo,
  rows: any[],
): CapabilityObservation[] {
  const childIds = new Set(session.childThreads?.map((child) => child.threadId));
  const pending = new Map<string, PendingCapabilityTool>();
  const completed = new Set<string>();
  const out: CapabilityObservation[] = [];

  const rememberCall = (
    rawName: unknown,
    rawInput: unknown,
    rawCallId: unknown,
    parentToolCallId: unknown,
    createdAt: number,
    fallbackId: string,
  ): void => {
    if (typeof rawName !== "string" || !rawName.trim()) return;
    const callId =
      typeof rawCallId === "string" && rawCallId.trim()
        ? rawCallId.trim()
        : fallbackId;
    if (completed.has(callId)) return;
    const sourceThreadId =
      typeof parentToolCallId === "string" && childIds.has(parentToolCallId)
        ? parentToolCallId
        : session.sessionId;
    const input = copilotToolInput(rawInput);
    const item: PendingCapabilityTool = {
      sourceId: `${sourceThreadId}:${callId}`,
      sessionId: session.sessionId,
      toolName: copilotCapabilityToolName(rawName, input),
      input,
      createdAt: createdAt || session.lastActivityAt,
      cwd: session.cwd ?? undefined,
    };
    if (pendingCapabilityObservation(item)) {
      rememberPendingCapabilityCall(pending, callId, item);
    }
  };

  rows.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const data = item.data ?? {};
    const rowAt = ts(item.timestamp) || session.lastActivityAt;
    if (item.type === "assistant.message" && Array.isArray(data.toolRequests)) {
      data.toolRequests.forEach((tool: any, toolIndex: number) => {
        rememberCall(
          tool?.name,
          tool?.arguments,
          tool?.toolCallId ?? tool?.id,
          data.parentToolCallId,
          rowAt,
          `${index}:${toolIndex}`,
        );
      });
      return;
    }
    if (item.type === "tool.execution_start") {
      rememberCall(
        data.toolName ?? data.name,
        data.arguments ?? data.input,
        data.toolCallId ?? data.id,
        data.parentToolCallId,
        rowAt,
        String(index),
      );
      return;
    }
    if (item.type !== "tool.execution_complete") return;
    const callId = String(data.toolCallId ?? data.id ?? "").trim();
    if (!callId) return;
    const pendingTool = pending.get(callId);
    if (!pendingTool) return;
    const result = Object.hasOwn(data, "result") ? data.result : data.error;
    const observation =
      observeCapability(pendingTool, result, rowAt) ??
      pendingCapabilityObservation(pendingTool);
    if (observation) rememberCapabilityObservation(out, observation);
    pending.delete(callId);
    completed.add(callId);
  });

  for (const pendingTool of pending.values()) {
    const observation = pendingCapabilityObservation(pendingTool);
    if (observation) rememberCapabilityObservation(out, observation);
  }
  return out;
}

export function scanCopilot(): Scan {
  const sessions: SessionInfo[] = [];
  let tokensRecent = 0;
  const seenSessionIds = new Set<string>();
  const nextLogPathBySession = new Map<string, string>();
  const files = recentLogs(copilotSessionsRoot(), 2).filter(
    (file) => basename(file) === "events.jsonl",
  );
  const activeFiles = new Set(files);

  for (const file of files) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    const cached = copilotSummaryCache.get(file);
    if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      const session = cached.session;
      if (!seenSessionIds.has(session.sessionId)) {
        seenSessionIds.add(session.sessionId);
        nextLogPathBySession.set(session.sessionId, file);
        if (Date.now() - session.lastActivityAt <= TOKEN_WINDOW_MS) {
          tokensRecent += session.tokensSession;
        }
        sessions.push(session);
      }
      continue;
    }

    let rows: any[];
    try {
      rows = readFileSync(file, "utf8")
        .split("\n")
        .map(safeParse)
        .filter((item): item is any => item != null);
    } catch {
      continue;
    }

    let sessionId = basename(dirname(file));
    let cwd: string | undefined;
    let title: string | undefined;
    let model: string | undefined;
    let startedAt = 0;
    let lastActivityAt = 0;
    let tokensSession = 0;
    let tokensLastTurn = 0;
    const children = new Map<string, ChildThreadInfo>();

    for (const item of rows) {
      const at = ts(item.timestamp);
      if (at) {
        if (!startedAt || at < startedAt) startedAt = at;
        if (at > lastActivityAt) lastActivityAt = at;
      }
      if (item.type === "session.start") {
        if (item.data?.sessionId) sessionId = String(item.data.sessionId);
        if (item.data?.context?.cwd) cwd = String(item.data.context.cwd);
        const start = ts(item.data?.startTime);
        if (start && (!startedAt || start < startedAt)) startedAt = start;
      }
      if (!title && item.type === "user.message" && typeof item.data?.content === "string") {
        const clean = item.data.content.replace(/\s+/g, " ").trim();
        if (clean) title = clean.slice(0, 120);
      }
      if (typeof item.data?.model === "string") model = item.data.model;
      if (item.type === "subagent.started" && typeof item.data?.toolCallId === "string") {
        const threadId = item.data.toolCallId;
        children.set(threadId, {
          threadId,
          parentThreadId: sessionId,
          title: childTitle(item.data.agentDescription ?? item.data.agentDisplayName),
          agentName: childTitle(item.data.agentDisplayName ?? item.data.agentName),
          depth: 1,
          state: "working",
          startedAt: at || lastActivityAt || stat.birthtimeMs || stat.mtimeMs,
          lastActivityAt: at || lastActivityAt || stat.mtimeMs,
          tokensSession: 0,
          tokensLastTurn: 0,
        });
      }
      const parentToolCallId =
        typeof item.data?.parentToolCallId === "string" ? item.data.parentToolCallId : undefined;
      const spent = Math.max(0, Number(item.data?.outputTokens) || 0);
      if (parentToolCallId && children.has(parentToolCallId)) {
        const child = children.get(parentToolCallId)!;
        child.lastActivityAt = Math.max(child.lastActivityAt, at || child.lastActivityAt);
        if (spent > 0) {
          child.tokensSession += spent;
          child.tokensLastTurn = spent;
        }
      } else if (spent > 0) {
        tokensSession += spent;
        tokensLastTurn = spent;
      }
      if (item.type === "subagent.completed" && typeof item.data?.toolCallId === "string") {
        const child = children.get(item.data.toolCallId);
        if (child) {
          child.state = "idle";
          child.lastActivityAt = Math.max(child.lastActivityAt, at || child.lastActivityAt);
        }
      }
    }

    lastActivityAt ||= stat.mtimeMs;
    for (const child of children.values()) {
      child.parentThreadId = sessionId;
      if (child.state === "working") child.state = stateFor(child.lastActivityAt);
    }
    const session = aggregateChildThreads({
      sessionId,
      agent: "copilot",
      title,
      cwd,
      model,
      state: stateFor(lastActivityAt),
      startedAt: startedAt || stat.birthtimeMs || lastActivityAt,
      lastActivityAt,
      tokensSession,
      tokensLastTurn,
    }, [...children.values()]);
    const observations = copilotCapabilityUsageFromRows(session, rows);
    copilotSummaryCache.set(file, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      session,
      observations,
    });
    if (!seenSessionIds.has(session.sessionId)) {
      seenSessionIds.add(session.sessionId);
      nextLogPathBySession.set(session.sessionId, file);
      if (Date.now() - session.lastActivityAt <= TOKEN_WINDOW_MS) {
        tokensRecent += session.tokensSession;
      }
      sessions.push(session);
    }
  }
  for (const file of copilotSummaryCache.keys()) {
    if (!activeFiles.has(file)) copilotSummaryCache.delete(file);
  }
  copilotLogPathBySession = nextLogPathBySession;
  return { sessions, tokensRecent };
}

export function copilotActivity(session: SessionInfo): ActivityEntry[] {
  let file = copilotLogPathBySession.get(session.sessionId);
  if (!file) {
    scanCopilot();
    file = copilotLogPathBySession.get(session.sessionId);
  }
  if (!file) return [];

  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").split("\n");
  } catch {
    return [];
  }

  const out: ActivityEntry[] = [];
  const seen = new Set<string>();
  const childById = new Map(session.childThreads?.map((child) => [child.threadId, child]));
  for (const line of lines) {
    const item = safeParse(line);
    if (
      item?.type !== "subagent.started" ||
      typeof item.data?.toolCallId !== "string" ||
      childById.has(item.data.toolCallId)
    ) continue;
    const createdAt = ts(item.timestamp) || session.startedAt;
    childById.set(item.data.toolCallId, {
      threadId: item.data.toolCallId,
      parentThreadId: session.sessionId,
      title: childTitle(item.data.agentDescription ?? item.data.agentDisplayName),
      agentName: childTitle(item.data.agentDisplayName ?? item.data.agentName),
      depth: 1,
      state: "idle",
      startedAt: createdAt,
      lastActivityAt: createdAt,
      tokensSession: 0,
      tokensLastTurn: 0,
    });
  }
  lines.forEach((line, index) => {
    const item = safeParse(line);
    if (!item) return;
    const createdAt = ts(item.timestamp) || session.lastActivityAt;
    if (item.type === "user.message") {
      pushEntry(out, seen, session.sessionId, "user", item.data?.content, createdAt, index);
      return;
    }
    if (item.type !== "assistant.message") return;
    const parentToolCallId =
      typeof item.data?.parentToolCallId === "string" ? item.data.parentToolCallId : undefined;
    const child = parentToolCallId ? childById.get(parentToolCallId) : undefined;
    const childFields = child ? childEntryFields(child) : {};
    const id = child ? `${child.threadId}:${createdAt}:${index}` : undefined;
    pushEntry(
      out, seen, session.sessionId, "message", item.data?.content, createdAt, index,
      childFields, id,
    );
    const tools = Array.isArray(item.data?.toolRequests) ? item.data.toolRequests : [];
    tools.forEach((tool: any, toolIndex: number) => {
      const classified = classifyTool(tool.name, tool.arguments);
      pushEntry(
        out,
        seen,
        session.sessionId,
        "tool",
        toolSummary(tool.name, tool.arguments),
        createdAt,
        index * 100 + toolIndex,
        {
          ...childFields,
          ...classified,
          estimatedContextTokens: estimateTokens(tool.arguments),
        },
        child ? `${child.threadId}:${createdAt}:${index * 100 + toolIndex}` : undefined,
      );
    });
  });
  return out;
}

/** Result-aware bounded MCP/skill/CLI observations from the latest scan. */
export function copilotCapabilityUsage(session: SessionInfo): CapabilityObservation[] {
  let file = copilotLogPathBySession.get(session.sessionId);
  if (!file) {
    scanCopilot();
    file = copilotLogPathBySession.get(session.sessionId);
  }
  const cached = file ? copilotSummaryCache.get(file) : undefined;
  return cached?.session.sessionId === session.sessionId ? cached.observations : [];
}
