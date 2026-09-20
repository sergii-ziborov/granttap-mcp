import { statSync } from "node:fs";
import type { ActivityEntry, ChildThreadInfo, SessionInfo } from "../../../../../../packages/protocol/schema";
import { classifyTool, estimateTokens, pushEntry, toolDescription, toolSummary } from "../../support/activity-helpers";
import { childEntryFields } from "../../support/child-threads";
import { diffPreviewFromInput, sensitivePath, statsFromInput } from "../../support/edit-stats";
import { redactSecrets } from "../../telemetry/command-preview";
import { recordObservedWrite, writtenPaths } from "../../../mesh/observed/writes";
import {
  activityTelemetry,
  observeCapability,
  pendingCapabilityObservation,
  rememberCapabilityObservation,
  rememberPendingCapabilityCall,
  type CapabilityObservation,
  type PendingCapabilityTool,
} from "../../telemetry";
import { recentLogs, codexSessionsRoot, safeParse, ts } from "../../support/common";
import { codexHeadRequest } from "../../support/codex-head";
import {
  CODEX_ACTIVITY_HEAD_BYTES,
  CODEX_ACTIVITY_TAIL_BYTES,
  codexActivitySourcesBySession,
  codexAggregatedObservationsBySession,
  codexLogPathBySession,
  codexSummaryCache,
  readCodexLogWindow,
} from "./shared";

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

  lines.forEach((line, index) => ingestCodexCapabilityRow({
    line, index, session, pending, nestedByCall, out,
  }));

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

function ingestCodexCapabilityRow(input: {
  line: string;
  index: number;
  session: SessionInfo;
  pending: Map<string, PendingCapabilityTool>;
  nestedByCall: Map<string, Array<{ toolName: string; server: string }>>;
  out: CapabilityObservation[];
}): void {
  const { line, index, session, pending, nestedByCall, out } = input;
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
}

function appendCodexActivity(input: {
  out: ActivityEntry[];
  seen: Set<string>;
  session: SessionInfo;
  lines: string[];
  observations: Map<string, CapabilityObservation>;
  child?: ChildThreadInfo;
}): void {
  const { out, seen, session, lines, observations, child } = input;
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
      pushEntry({ out: out, seen: seen, sessionId: session.sessionId, kind: "user", text: p.message ?? p.text, createdAt: createdAt, ordinal: index, extras: childFields, idOverride: entryId(createdAt, index) });
      return;
    }
    if (d.type === "event_msg" && p.type === "agent_message") {
      pushEntry({ out: out, seen: seen, sessionId: session.sessionId, kind: "message", text: p.message ?? p.text, createdAt: createdAt, ordinal: index, extras: childFields, idOverride: entryId(createdAt, index) });
      return;
    }
    if (d.type !== "response_item") return;
    if (p.type === "message" && p.role === "user" && Array.isArray(p.content)) {
      p.content.forEach((block: any, blockIndex: number) => {
        if (block?.type === "input_text" || block?.type === "text") {
          const ordinal = index * 100 + blockIndex;
          pushEntry({ out: out, seen: seen, sessionId: session.sessionId, kind: "user", text: block.text, createdAt: createdAt, ordinal: ordinal, extras: childFields, idOverride: entryId(createdAt, ordinal) });
        }
      });
    } else if (p.type === "message" && p.role === "assistant" && Array.isArray(p.content)) {
      p.content.forEach((block: any, blockIndex: number) => {
        if (block?.type === "output_text" || block?.type === "text") {
          const ordinal = index * 100 + blockIndex;
          pushEntry({ out: out, seen: seen, sessionId: session.sessionId, kind: "message", text: block.text, createdAt: createdAt, ordinal: ordinal, extras: childFields, idOverride: entryId(createdAt, ordinal) });
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
      pushEntry({ out: out, seen: seen, sessionId: session.sessionId, kind: "tool", text: toolSummary(toolName, args), createdAt: createdAt, ordinal: index, extras: {
          ...childFields,
          ...classified,
          ...(statsFromInput(toolName, args) ?? {}),
          ...(toolDescription(args) ? { summary: toolDescription(args) } : {}),
          ...(statsFromInput(toolName, args)
            && !sensitivePath((args as Record<string, unknown> | undefined)?.file_path ?? (args as Record<string, unknown> | undefined)?.path)
            ? { diffPreview: diffPreviewFromInput(toolName, args, redactSecrets) }
            : {}),
          ...(observation
            ? activityTelemetry(observation)
            : { estimatedContextTokens: estimateTokens(args) }),
        }, idOverride: observation ? sourceId : entryId(createdAt, index) });
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
    appendCodexActivity({ out, seen: new Set<string>(), session, lines, observations });
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
      pushEntry({ out: out, seen: seen, sessionId: session.sessionId, kind: "user", text: head.text, createdAt: createdAt, ordinal: -1, extras: childFields, idOverride: source.child ? `${source.child.threadId}:${createdAt}:-1` : undefined });
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
    appendCodexActivity({ out, seen, session, lines, observations, child: source.child });
  }
  // V8 sort is stable: preserve transcript/source order when providers stamp a
  // whole batch with the same millisecond. Source ids are not chronological.
  return out.sort((a, b) => a.createdAt - b.createdAt);
}
