import { appendCodexActivity } from "./activity/rows";
export { appendCodexActivity } from "./activity/rows";
import { recordedFileChanges } from "../../../transcript-history/changes";
import { recordedToolDetails } from "../../../transcript-history/tool-details";
import { statSync } from "node:fs";
import type { ActivityEntry, SessionInfo } from "../../../../../../packages/protocol/schema";
import { estimateTokens, pushEntry } from "../../support/activity-helpers";
import { childEntryFields } from "../../support/child-threads";


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
import { safeParse, ts } from "../../support/common";
import { codexHeadRequest } from "../../support/codex-head";
import {
  CODEX_ACTIVITY_HEAD_BYTES,
  CODEX_ACTIVITY_TAIL_BYTES,
  codexActivitySourcesBySession,
  codexAggregatedObservationsBySession,
  codexLogPathBySession,
  codexLogLines,
  codexSummaryCache,
  readCodexLogWindow,
} from "./shared";

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


export { codexImageChunk } from "./image";

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
    appendCodexActivity({ out, seen: new Set<string>(), session, lines, observations, changes: recordedFileChanges(lines), details: recordedToolDetails(lines) });
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
    appendCodexActivity({ out, seen, session, lines, observations, child: source.child,
      changes: recordedFileChanges(lines), details: recordedToolDetails(lines) });
  }
  // V8 sort is stable: preserve transcript/source order when providers stamp a
  // whole batch with the same millisecond. Source ids are not chronological.
  return out.sort((a, b) => a.createdAt - b.createdAt);
}
