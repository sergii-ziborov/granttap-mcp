import { readFileSync } from "node:fs";
import type { ActivityEntry, ChildThreadInfo, SessionInfo } from "../../../../../packages/protocol/schema";
import { classifyTool, estimateTokens, pushEntry, toolSummary } from "../activity-helpers";
import { childEntryFields } from "../child-threads";
import { safeParse, stateFor } from "../common";
import type { CapabilityObservation } from "../telemetry";
import { cursorFiles, cursorUsage, scanCursor } from "./scan";
import { textBlocks } from "./transcripts";

function appendFileActivity(
  out: ActivityEntry[],
  seen: Set<string>,
  sessionId: string,
  file: string,
  baseTime: number,
  indexOffset: number,
  child?: ChildThreadInfo,
): void {
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").split("\n");
  } catch {
    return;
  }
  const childFields = child ? childEntryFields(child) : {};
  const sourceThreadId = child?.threadId ?? sessionId;
  const entryId = (createdAt: number, ordinal: number): string | undefined =>
    child ? `${sourceThreadId}:${createdAt}:${ordinal}` : undefined;
  lines.forEach((line, index) => {
    const item = safeParse(line);
    if (!item) return;
    const createdAt = (typeof item.timestamp === "number" ? item.timestamp : 0)
      || baseTime + (indexOffset + index) * 1_000;
    if (item.role === "user") {
      const text = textBlocks(item.message?.content).join("\n").trim();
      if (!text) return;
      const ordinal = indexOffset + index;
      pushEntry(out, seen, sessionId, "user", text, createdAt, ordinal,
        childFields, entryId(createdAt, ordinal));
      return;
    }
    if (item.role !== "assistant") return;
    const content = item.message?.content;
    if (typeof content === "string") {
      const ordinal = indexOffset + index;
      pushEntry(out, seen, sessionId, "message", content, createdAt, ordinal,
        childFields, entryId(createdAt, ordinal));
      return;
    }
    if (!Array.isArray(content)) return;
    content.forEach((block: any, blockIndex: number) => {
      const sequence = (indexOffset + index) * 100 + blockIndex;
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        pushEntry(out, seen, sessionId, "message", block.text, createdAt, sequence,
          childFields, entryId(createdAt, sequence));
      } else if (block?.type === "tool_use") {
        pushEntry(out, seen, sessionId, "tool", toolSummary(block.name, block.input),
          createdAt, sequence, {
            ...childFields,
            ...classifyTool(block.name, block.input),
            estimatedContextTokens: estimateTokens(block.input),
          }, entryId(createdAt, sequence));
      }
    });
  });
}

export function cursorActivity(session: SessionInfo): ActivityEntry[] {
  let files = cursorFiles(session.sessionId);
  if (!files) {
    scanCursor();
    files = cursorFiles(session.sessionId) ?? [];
  }
  const out: ActivityEntry[] = [];
  const seen = new Set<string>();
  const children = new Map(session.childThreads?.map((child) => [child.threadId, child]));
  files.forEach((file, index) => {
    const base = file.birthtimeMs || file.mtimeMs || session.startedAt;
    const childId = file.isSubagent ? file.threadId : undefined;
    const child = childId ? children.get(childId) ?? {
      threadId: childId, parentThreadId: session.sessionId, depth: 1,
      state: stateFor(base), startedAt: base, lastActivityAt: base,
      tokensSession: 0, tokensLastTurn: 0,
    } : undefined;
    appendFileActivity(out, seen, session.sessionId, file.path, base, index * 10_000, child);
  });
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

export function cursorCapabilityUsage(session: SessionInfo): CapabilityObservation[] {
  let observations = cursorUsage(session.sessionId);
  if (!observations) {
    scanCursor();
    observations = cursorUsage(session.sessionId);
  }
  return observations ?? [];
}
