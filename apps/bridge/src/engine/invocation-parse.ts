import { createHash } from "node:crypto";
import { writtenPaths } from "../mesh/observed-writes";
import type { InvocationPhase, InvocationSource } from "./engine-invocation-protocol";

type Provider = "claude" | "codex" | "cursor";
type Pending = { toolName: string; resources: Array<string | undefined> };
export type InvocationParseState = { pending: Map<string, Pending> };
export type InvocationFact = {
  callId: string;
  toolName: string;
  phase: InvocationPhase;
  source: InvocationSource;
  occurredAt: number;
  resource?: string;
  policyRevision?: number;
  policyRuleId?: string;
  capabilityArtifactHash?: string;
};

export function sourceGapFact(offset: number, occurredAt = 0): InvocationFact {
  return { callId: `gap-${offset}`, toolName: "Transcript gap", phase: "source_gap",
    source: "scanner", occurredAt };
}

export function parseInvocationLine(
  provider: Provider, line: string, state: InvocationParseState, offset: number,
): InvocationFact[] {
  if (!line.trim()) return [];
  let row: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) return [sourceGapFact(offset)];
    row = parsed;
  } catch {
    return [sourceGapFact(offset)];
  }
  const at = timestamp(row.timestamp);
  if (provider === "codex") return codexFacts(row, state, offset, at);
  const message = isRecord(row.message) ? row.message : undefined;
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks.flatMap((block, index) => {
    if (!isRecord(block)) return [];
    if (block.type === "tool_use" && typeof block.name === "string") {
      const callId = typeof block.id === "string" && block.id
        ? nativeId(block.id) : `anonymous-${offset}-${index}`;
      return requested(state, callId, block.name, block.input, at);
    }
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      return completed(state, nativeId(block.tool_use_id), outcome(block), at, offset);
    }
    return [];
  });
}

function codexFacts(
  row: Record<string, unknown>, state: InvocationParseState, offset: number, at: number,
): InvocationFact[] {
  if (row.type !== "response_item" || !isRecord(row.payload)) return [];
  const payload = row.payload;
  if (["function_call", "custom_tool_call", "local_shell_call"].includes(String(payload.type))) {
    const callId = nativeId(String(payload.call_id ?? payload.id ?? `anonymous-${offset}`));
    const name = typeof payload.name === "string" ? payload.name : String(payload.type);
    let input = payload.arguments ?? payload.input ?? payload.command;
    if (typeof input === "string") {
      try { input = JSON.parse(input) as unknown; }
      catch { input = name === "apply_patch" ? { patch: input } : { command: input }; }
    }
    return requested(state, callId, name, input, at);
  }
  if (["function_call_output", "custom_tool_call_output"].includes(String(payload.type))) {
    const callId = nativeId(String(payload.call_id ?? payload.id ?? ""));
    return completed(state, callId, outcome(payload), at, offset);
  }
  return [];
}

function requested(
  state: InvocationParseState, callId: string, name: string, input: unknown, at: number,
): InvocationFact[] {
  const toolName = name.trim().replace(/[\u0000-\u001f]/g, " ").slice(0, 160) || "Unknown tool";
  const resources = [...new Set(writtenPaths(toolName, input))].slice(0, 16);
  const paths: Array<string | undefined> = resources.length ? resources : [undefined];
  state.pending.set(callId, { toolName, resources: paths });
  return paths.map((resource) => ({ callId, toolName, phase: "requested", source: "transcript",
    occurredAt: at, resource }));
}

function completed(
  state: InvocationParseState, callId: string, phase: InvocationPhase,
  at: number, offset: number,
): InvocationFact[] {
  const pending = state.pending.get(callId);
  if (!pending) return [sourceGapFact(offset, at)];
  state.pending.delete(callId);
  return pending.resources.map((resource) => ({ callId, toolName: pending.toolName,
    phase, source: "transcript", occurredAt: at, resource }));
}

function outcome(row: Record<string, unknown>): InvocationPhase {
  if (row.is_error === true || row.isError === true || row.success === false
    || row.status === "error" || row.status === "failed") return "reported_failure";
  if (row.is_error === false || row.isError === false || row.success === true
    || row.status === "success") return "reported_success";
  return "reported_unknown";
}

function nativeId(value: string): string {
  return value.length <= 128 && value.trim() && !/[\u0000-\u001f]/.test(value)
    ? value : createHash("sha256").update(value).digest("hex");
}

function timestamp(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
