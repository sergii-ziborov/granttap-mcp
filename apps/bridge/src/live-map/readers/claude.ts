import { claudeContextReport } from "../../sessions/context-usage";
import { harnessUserNotice } from "../../sessions/support/activity-helpers";
import { classifyCall, modelName } from "../classification/tools";
import { CallBook, failedStatus, parseRow, resultText, timeOf, type Observation } from "./shared";

const FINISHED = new Set(["end_turn", "stop_sequence", "max_tokens"]);
/**
 * A call started in the background (a build, a test run) answers at once and goes on working; the
 * host writes a task notification naming the call when it is done. One whose notice never came,
 * because the host stopped, stops counting as running after the longest a phone run keeps it.
 */
export const BACKGROUND_MAX_MS = 2 * 60 * 60_000;
const NOTICE = /<task-notification>[\s\S]*?<tool-use-id>([^<\s]+)<\/tool-use-id>[\s\S]*?<status>([^<\s]+)<\/status>/;

type Loop = { book: CallBook; agentKey?: string; root: boolean; background: Set<string>;
  state: { model?: string; context?: Observation["context"] } };

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
    if (block.input?.run_in_background === true) loop.background.add(block.id);
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
      // A call started in the background is still at work when it answers; its notice ends it.
      if (block.is_error !== true && loop.background.has(block.tool_use_id)) continue;
      loop.book.end(block.tool_use_id, at, block.is_error === true ? failedStatus(resultText(block.content)) : "ok");
    }
  } else readNotice(content, at, loop);
  if (loop.root && personSpoke(row)) loop.book.mark(`message:${row.uuid ?? at}`, "you", "message", at, "message");
}

/** The host's notice that a call started in the background is done, by the call's id. */
function readNotice(text: unknown, at: number, loop: Loop): void {
  const notice = typeof text === "string" ? NOTICE.exec(text) : null;
  if (!notice || !loop.background.has(notice[1]!)) return;
  loop.book.end(notice[1]!, at, notice[2] === "completed" ? "ok" : "error");
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
    // The notice is queued for the agent the moment the call ends, while the agent may be idle.
    else if (row.type === "queue-operation" && row.operation === "enqueue") readNotice(row.content, at, inline);
    else if (row.type === "system" && row.subtype === "compact_boundary" && inline.root) {
      loop.book.mark(`compact:${row.uuid ?? at}`, "model", "compaction", at, "compact");
    }
  }
}

/**
 * A Claude chat's recent rows and its subagents' rows as calls and moments. A Claude transcript
 * reports the tokens a step was answered over but not the window, so no percentage is made up.
 */
export function claudeObservation(root: string[], children: Array<{ agentKey: string; lines: string[] }> = [],
  now = Date.now()): Observation {
  const book = new CallBook();
  const state: Loop["state"] = {};
  const background = new Set<string>();
  readRows(root, { book, root: true, state, background });
  for (const child of children) {
    readRows(child.lines, { book, root: false, agentKey: child.agentKey, state, background });
  }
  for (const call of book.running()) {
    if (background.has(call.key) && now - call.startedAt > BACKGROUND_MAX_MS) {
      book.end(call.key, call.startedAt + BACKGROUND_MAX_MS, "ok");
    }
  }
  return book.observation({ model: state.model, context: state.context });
}
