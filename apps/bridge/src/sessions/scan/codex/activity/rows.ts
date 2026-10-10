import { createHash } from "node:crypto";
import type { ActivityEntry, ChildThreadInfo, SessionInfo } from "../../../../../../../packages/protocol/schema";
import { safeParse, ts } from "../../../support/common";
import { classifyTool, estimateTokens, pushEntry as appendEntry, type PushEntryInput, toolDescription, toolSummary } from "../../../support/activity-helpers";
import { childEntryFields } from "../../../support/child-threads";
import { diffPreviewFromInput, sensitivePath, statsFromInput } from "../../../support/edit-stats";
import { redactSecrets } from "../../../telemetry/command-preview";
import { activityTelemetry, pendingCapabilityObservation, type CapabilityObservation, type PendingCapabilityTool } from "../../../telemetry";
import type { RecordedFileChange } from "../../../../transcript-history/changes";
import type { ToolCallDetail } from "../../../../transcript-history/tool-details";

function codexToolInput(payload: any): unknown {
  const input = payload.arguments ?? payload.input ?? payload.action;
  if (typeof input !== "string") return input;
  try { return JSON.parse(input); } catch { return input; }
}

export function appendCodexActivity(input: {
  out: ActivityEntry[];
  seen: Set<string>;
  session: SessionInfo;
  lines: string[];
  observations: Map<string, CapabilityObservation>;
  child?: ChildThreadInfo;
  fullText?: boolean;
  changes?: Map<string, RecordedFileChange[]>;
  details?: Map<string, ToolCallDetail>;
}): void {
  const pushEntry = (entry: PushEntryInput) => appendEntry({ ...entry, fullText: input.fullText });
  const { out, seen, session, lines, observations, child, changes, details } = input;
  const sourceThreadId = child?.threadId ?? session.sessionId;
  const childFields = child ? childEntryFields(child) : {};
  lines.forEach((line, index) => {
    const d = safeParse(line);
    if (!d) return;
    const p = d.payload ?? {};
    const hash = createHash("sha256").update(line).digest("hex").slice(0, 16);
    const entryId = (at: number, block: number) => `${sourceThreadId}:${at}:${hash}:${block % 100}`;
    const createdAt = ts(d.timestamp) || session.lastActivityAt;
    if (d.type === "event_msg" && p.type === "item_completed" && p.item?.type === "FileChange") {
      const files = changes?.get(p.item.id);
      if (files?.length) out.push({ id: `${sourceThreadId}:${p.item.id}`, kind: "tool",
        text: `apply_patch: ${files.map((file) => file.path).join(", ")}`, createdAt,
        toolName: "apply_patch", outcome: "success", fileChanges: files, ...childFields });
      return;
    }
    if (d.type === "event_msg" && p.type === "user_message") {
      pushEntry({ out: out, seen: seen, sessionId: session.sessionId, kind: "user", text: p.message ?? p.text, createdAt: createdAt, ordinal: index, extras: childFields, idOverride: entryId(createdAt, 0) });
      return;
    }
    if (d.type === "event_msg" && p.type === "agent_message") {
      pushEntry({ out: out, seen: seen, sessionId: session.sessionId,
        kind: p.phase === "final" || p.phase === "final_answer" ? "final" : "message",
        text: p.message ?? p.text, createdAt, ordinal: index, extras: childFields,
        idOverride: entryId(createdAt, 0) });
      return;
    }
    if (d.type !== "response_item") return;
    if (p.type === "message" && p.role === "user" && Array.isArray(p.content)) {
      p.content.forEach((block: any, blockIndex: number) => {
        if (block?.type === "input_text" || block?.type === "text") {
          const ordinal = index * 100 + blockIndex;
          pushEntry({ out: out, seen: seen, sessionId: session.sessionId, kind: "user", text: block.text, createdAt: createdAt, ordinal: ordinal, extras: childFields, idOverride: entryId(createdAt, ordinal) });
        } else if (block?.type === "input_image" && typeof block.image_url === "string") {
          const ordinal = blockIndex;
          out.push({ id: `${session.sessionId}:${createdAt}:${ordinal}`,
            kind: "user", text: "", createdAt,
            attachments: ["Image"], ...childFields });
        }
      });
    } else if (p.type === "message" && p.role === "assistant" && Array.isArray(p.content)) {
      p.content.forEach((block: any, blockIndex: number) => {
        if (block?.type === "output_text" || block?.type === "text") {
          const ordinal = index * 100 + blockIndex;
          pushEntry({ out: out, seen: seen, sessionId: session.sessionId,
            kind: p.channel === "final" || p.phase === "final_answer" || p.phase === "final" ? "final" : "message",
            text: block.text, createdAt, ordinal, extras: childFields, idOverride: entryId(createdAt, ordinal) });
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
          ...(details?.get(callId) ?? {}),
          ...(changes?.has(callId) ? { fileChanges: changes.get(callId) } : {}),
          ...(statsFromInput(toolName, args) ?? {}),
          ...(toolDescription(args) ? { summary: toolDescription(args) } : {}),
          ...(statsFromInput(toolName, args)
            && !sensitivePath((args as Record<string, unknown> | undefined)?.file_path ?? (args as Record<string, unknown> | undefined)?.path)
            ? { diffPreview: diffPreviewFromInput(toolName, args, redactSecrets) }
            : {}),
          ...(observation
            ? activityTelemetry(observation)
            : { estimatedContextTokens: estimateTokens(args) }),
        }, idOverride: sourceId });
    }
  });
}
