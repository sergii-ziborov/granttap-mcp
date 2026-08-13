import type { SessionInfo } from "../../../../packages/protocol/schema";
import { normalizeMcpServerName } from "./activity-helpers";
import { ts } from "./common";
import {
  observeCapability,
  pendingCapabilityObservation,
  rememberCapabilityObservation,
  rememberPendingCapabilityCall,
  type CapabilityObservation,
  type PendingCapabilityTool,
} from "./telemetry";

export function copilotCapabilityUsageFromRows(
  session: SessionInfo,
  rows: any[],
): CapabilityObservation[] {
  const childIds = new Set(session.childThreads?.map((child) => child.threadId));
  const pending = new Map<string, PendingCapabilityTool>();
  const completed = new Set<string>();
  const observations: CapabilityObservation[] = [];
  rows.forEach((item, index) => processRow(item, index, session, childIds, pending, completed, observations));
  for (const pendingTool of pending.values()) {
    const observation = pendingCapabilityObservation(pendingTool);
    if (observation) rememberCapabilityObservation(observations, observation);
  }
  return observations;
}

function processRow(
  item: any,
  index: number,
  session: SessionInfo,
  childIds: Set<string | undefined>,
  pending: Map<string, PendingCapabilityTool>,
  completed: Set<string>,
  observations: CapabilityObservation[],
): void {
  if (!item || typeof item !== "object") return;
  const data = item.data ?? {};
  const createdAt = ts(item.timestamp) || session.lastActivityAt;
  if (item.type === "assistant.message" && Array.isArray(data.toolRequests)) {
    data.toolRequests.forEach((tool: any, toolIndex: number) => {
      rememberCall(tool?.name, tool?.arguments, tool?.toolCallId ?? tool?.id, data.parentToolCallId, `${index}:${toolIndex}`, createdAt, session, childIds, pending, completed);
    });
    return;
  }
  if (item.type === "tool.execution_start") {
    rememberCall(data.toolName ?? data.name, data.arguments ?? data.input, data.toolCallId ?? data.id, data.parentToolCallId, String(index), createdAt, session, childIds, pending, completed);
    return;
  }
  if (item.type === "tool.execution_complete") completeCall(data, createdAt, pending, completed, observations);
}

function rememberCall(
  rawName: unknown,
  rawInput: unknown,
  rawCallId: unknown,
  parentToolCallId: unknown,
  fallbackId: string,
  createdAt: number,
  session: SessionInfo,
  childIds: Set<string | undefined>,
  pending: Map<string, PendingCapabilityTool>,
  completed: Set<string>,
): void {
  if (typeof rawName !== "string" || !rawName.trim()) return;
  const callId = typeof rawCallId === "string" && rawCallId.trim() ? rawCallId.trim() : fallbackId;
  if (completed.has(callId)) return;
  const sourceThreadId = typeof parentToolCallId === "string" && childIds.has(parentToolCallId)
    ? parentToolCallId
    : session.sessionId;
  const item: PendingCapabilityTool = {
    sourceId: `${sourceThreadId}:${callId}`,
    sessionId: session.sessionId,
    toolName: capabilityToolName(rawName, toolInput(rawInput)),
    input: toolInput(rawInput),
    createdAt,
    cwd: session.cwd ?? undefined,
  };
  if (pendingCapabilityObservation(item)) rememberPendingCapabilityCall(pending, callId, item);
}

function completeCall(
  data: Record<string, unknown>,
  createdAt: number,
  pending: Map<string, PendingCapabilityTool>,
  completed: Set<string>,
  observations: CapabilityObservation[],
): void {
  const callId = String(data.toolCallId ?? data.id ?? "").trim();
  if (!callId) return;
  const pendingTool = pending.get(callId);
  if (!pendingTool) return;
  const result = Object.hasOwn(data, "result") ? data.result : data.error;
  const observation = observeCapability(pendingTool, result, createdAt) ?? pendingCapabilityObservation(pendingTool);
  if (observation) rememberCapabilityObservation(observations, observation);
  pending.delete(callId);
  completed.add(callId);
}

function capabilityToolName(rawName: string, input: unknown): string {
  const name = rawName.trim();
  if (/^(CallMcpTool|GetMcpTools)$/i.test(name) && input && typeof input === "object") {
    const meta = input as Record<string, unknown>;
    const server = typeof meta.server === "string" ? normalizeMcpServerName(meta.server) : "";
    const tool = typeof meta.toolName === "string" && meta.toolName.trim() ? meta.toolName.trim() : name;
    if (server) return `mcp__${server}__${tool}`;
  }
  const flattened = /^(.+?mcp(?:-server)?)[-_.](.+)$/i.exec(name);
  return flattened?.[1] && flattened[2]
    ? `mcp__${normalizeMcpServerName(flattened[1])}__${flattened[2]}`
    : name;
}

function toolInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
