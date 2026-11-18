import { claudeContextReport } from "../../sessions/context-usage";
import { harnessUserNotice } from "../../sessions/support/activity-helpers";
import { classifyCall, modelName } from "../classification/tools";
import { CallBook, failedStatus, parseRow, resultText, timeOf, type Observation } from "./shared";

const FINISHED = new Set(["end_turn", "stop_sequence", "max_tokens"]);

type Loop = { book: CallBook; agentKey?: string; root: boolean; state: { model?: string;
  context?: Observation["context"] } };

/** Words the person typed, not a notice the host wrote as a user turn. */
function personSpoke(row: any): boolean {
  if (row.isMeta === true) return false;
  const content = row.message?.content;
  const texts = typeof content === "string" ? [content]
    : Array.isArray(content) ? content.filter((block: any) => block?.type === "text").map((block: any) => block.text) : [];
  return texts.some(text => typeof text === "string" && text.trim() !== "" && !harnessUserNotice(text)
    && !text.startsWith("<system-reminder>") && !text.startsWith("[Request interrupted"));
}

function readAssistant(row: any, at: number, loop: Loop): void {
  const message = row.message ?? {};
  const { book, agentKey, state } = loop;
  const id = typeof message.id === "string" ? message.id : `${at}`;
  const model = modelName(message.model);
  if (loop.root && model && state.model && model !== state.model) {
    book.mark(`model:${id}`, "model", model, at, "model", { model });
  }
  if (loop.root && model) state.model = model;
  book.mark(`step:${agentKey ?? ""}:${id}`, "model", "model step", at, "step", agentKey ? { agentKey } : {});
  if (loop.root && message.usage) {
    const usage = claudeContextReport(message.usage, at);
    if (usage) state.context = { usedTokens: usage.usedTokens };
  }
  const blocks = Array.isArray(message.content) ? message.content : [];
  for (const block of blocks) {
    if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
    const { station, name } = classifyCall(String(block.name ?? "tool"), block.input);
    book.add({ key: block.id, station, name, startedAt: at, status: "run", ...(agentKey ? { agentKey } : {}) });
  }
  if (loop.root && FINISHED.has(message.stop_reason) && !blocks.some((block: any) => block?.type === "tool_use")) {
    book.mark(`answer:${id}`, "you", "answer", at, "answer");
  }
}

function readUser(row: any, at: number, loop: Loop): void {
  const content = row.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      loop.book.end(block.tool_use_id, at, block.is_error === true ? failedStatus(resultText(block.content)) : "ok");
    }
  }
  if (loop.root && personSpoke(row)) loop.book.mark(`message:${row.uuid ?? at}`, "you", "message", at, "message");
}

function readRows(lines: string[], loop: Loop): void {
  for (const line of lines) {
    const row = parseRow(line);
    if (!row || typeof row !== "object") continue;
    const at = timeOf(row.timestamp);
    if (!at) continue;
    // Older Claude Code wrote a subagent's rows into the chat's own file.
    const inline: Loop = row.isSidechain === true && loop.root
      ? { ...loop, root: false, agentKey: String(row.agentId ?? "sidechain") } : loop;
    if (row.type === "assistant") readAssistant(row, at, inline);
    else if (row.type === "user") readUser(row, at, inline);
    else if (row.type === "system" && row.subtype === "compact_boundary" && inline.root) {
      loop.book.mark(`compact:${row.uuid ?? at}`, "model", "compaction", at, "compact");
    }
  }
}

/**
 * A Claude chat's recent rows and its subagents' rows as calls and moments. A Claude transcript
 * reports the tokens a step was answered over but not the window, so no percentage is made up.
 */
export function claudeObservation(root: string[], children: Array<{ agentKey: string; lines: string[] }> = []): Observation {
  const book = new CallBook();
  const state: Loop["state"] = {};
  readRows(root, { book, root: true, state });
  for (const child of children) readRows(child.lines, { book, root: false, agentKey: child.agentKey, state });
  return book.observation({ model: state.model, context: state.context });
}
