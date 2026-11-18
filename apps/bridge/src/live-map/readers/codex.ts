import { codexContextReport } from "../../sessions/context-usage";
import { classifyCall, modelName } from "../classification/tools";
import { CallBook, failedStatus, parseRow, timeOf, type CallStatus, type Observation } from "./shared";

const CALLS = new Set(["function_call", "custom_tool_call", "local_shell_call"]);
const OUTPUTS = new Set(["function_call_output", "custom_tool_call_output"]);

/** `turn` counts the person's messages, so a turn's final message and its completion are one answer. */
type State = { book: CallBook; turn: number; model?: string; context?: Observation["context"] };

function inputOf(payload: any): unknown {
  const input = payload.arguments ?? payload.input ?? payload.action;
  if (typeof input !== "string") return input;
  try { return JSON.parse(input); } catch { return input; }
}

/** A tool's name as Codex records it; an MCP tool keeps its server, as `mcp__server__tool`. */
function toolName(payload: any): string {
  const name = String(payload.name ?? payload.type);
  const namespace = payload.namespace;
  return typeof namespace === "string" && /^mcp__[A-Za-z0-9_-]+$/.test(namespace) ? `${namespace}__${name}` : name;
}

/** How a call ended, read from its output for an exit code or a refusal and for nothing else. */
export function codexOutcome(output: unknown): CallStatus {
  let text = typeof output === "string" ? output : JSON.stringify(output ?? "") ?? "";
  try {
    const parsed = JSON.parse(text);
    const code = parsed?.metadata?.exit_code;
    if (typeof code === "number") return code === 0 ? "ok" : "error";
    if (typeof parsed?.output === "string") text = parsed.output;
  } catch { /* a plain-text output */ }
  const head = text.slice(0, 400);
  if (/rejected by (?:the )?user|approval (?:was )?denied|denied by|declined|blocked by/i.test(head)) return "blocked";
  const code = /(?:^|\n)\s*(?:Exit code|Process exited with code):?\s*(-?\d+)/i.exec(head);
  if (code) return code[1] === "0" ? "ok" : "error";
  return /^\s*(?:error|failed|aborted)\b/i.test(head) ? failedStatus(head) : "ok";
}

function readItem(payload: any, at: number, index: number, state: State): void {
  const { book } = state;
  if (CALLS.has(payload.type)) {
    const key = String(payload.call_id ?? payload.id ?? `${at}:${index}`);
    const { station, name } = classifyCall(toolName(payload), inputOf(payload));
    book.add({ key, station, name, startedAt: at, status: "run" });
    if (payload.type === "local_shell_call" && payload.status === "completed") book.end(key, at, "ok");
  } else if (OUTPUTS.has(payload.type)) {
    book.end(String(payload.call_id ?? payload.id ?? ""), at, codexOutcome(payload.output ?? payload.content));
  } else if (payload.type === "web_search_call") {
    const key = String(payload.id ?? `${at}:${index}`);
    book.add({ key, station: "web", name: "web search", startedAt: at, status: "run" });
    book.end(key, at, payload.status === "failed" ? "error" : "ok");
  } else if (payload.type === "reasoning") {
    book.mark(`step:${payload.id ?? `${at}:${index}`}`, "model", "model step", at, "step");
  } else if (payload.type === "message" && payload.role === "assistant"
    && (payload.phase === "final_answer" || payload.phase === "final" || payload.channel === "final")) {
    book.mark(`answer:${state.turn}`, "you", "answer", at, "answer");
  }
}

function readEvent(payload: any, at: number, index: number, state: State): void {
  const { book } = state;
  if (payload.type === "user_message") {
    state.turn += 1;
    book.mark(`message:${at}:${index}`, "you", "message", at, "message");
  } else if (payload.type === "task_complete" || payload.type === "turn_complete") {
    book.mark(`answer:${state.turn}`, "you", "answer", at, "answer");
  } else if (payload.type === "exec_command_end" && typeof payload.call_id === "string") {
    book.end(payload.call_id, at, typeof payload.exit_code === "number" && payload.exit_code !== 0 ? "error" : "ok");
  } else if (payload.type === "token_count") {
    const usage = codexContextReport(payload.info, at);
    if (usage) state.context = { usedTokens: usage.usedTokens, windowTokens: usage.windowTokens };
  } else if (payload.type === "context_compacted") {
    book.mark(`compact:${at}`, "model", "compaction", at, "compact");
  }
}

/** A Codex rollout's recent rows as calls and moments; its `token_count` reports the window. */
export function codexObservation(lines: string[]): Observation {
  const state: State = { book: new CallBook(), turn: 0 };
  lines.forEach((line, index) => {
    const row = parseRow(line);
    if (!row || typeof row !== "object") return;
    const at = timeOf(row.timestamp);
    if (!at) return;
    const payload = row.payload ?? {};
    if (row.type === "turn_context") {
      const model = modelName(payload.model);
      if (model && state.model && model !== state.model) {
        state.book.mark(`model:${at}`, "model", model, at, "model", { model });
      }
      if (model) state.model = model;
    } else if (row.type === "response_item") readItem(payload, at, index, state);
    else if (row.type === "event_msg") readEvent(payload, at, index, state);
    else if (row.type === "compacted") state.book.mark(`compact:${at}`, "model", "compaction", at, "compact");
  });
  return state.book.observation({ model: state.model, context: state.context });
}
