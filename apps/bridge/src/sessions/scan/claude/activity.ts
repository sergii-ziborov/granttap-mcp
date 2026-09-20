import { readFileSync, statSync } from "node:fs";
import type { ActivityEntry, ChildThreadInfo, SessionInfo } from "../../../../../../packages/protocol/schema";
import { safeParse, ts } from "../../support/common";
import { classifyTool, estimateTokens, pushEntry, toolDescription, toolSummary } from "../../support/activity-helpers";
import { childEntryFields } from "../../support/child-threads";
import { diffPreviewFromInput, patchStatsByToolUse, sensitivePath, statsFromInput } from "../../support/edit-stats";
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
import {
  childLogsFingerprint,
  claudeChildLogPaths,
  claudeChildLogPathsBySession,
  claudeChildSummary,
  claudeLogLines,
  claudeLogPath,
  claudeLogPathBySession,
  claudeSummaryCache,
  readLines,
} from "./shared";

function cachedClaudeCapabilityUsage(
  sessionId: string,
): CapabilityObservation[] | undefined {
  const file = claudeLogPathBySession.get(sessionId);
  if (!file) return undefined;
  const cached = claudeSummaryCache.get(file);
  if (!cached || cached.session.sessionId !== sessionId) return undefined;
  try {
    const stat = statSync(file);
    if (stat.mtimeMs !== cached.mtimeMs || stat.size !== cached.size) return undefined;
    const childPaths = claudeChildLogPathsBySession.get(sessionId) ?? [];
    if (childLogsFingerprint(childPaths) !== cached.childFingerprint) return undefined;
  } catch {
    return undefined;
  }
  return cached.observations;
}

/** Pair Claude tool_use/tool_result rows without exposing result contents. */
export function claudeCapabilityUsage(
  session: SessionInfo,
  lines?: string[],
  sourceThreadId = session.sessionId,
): CapabilityObservation[] {
  if (!lines) {
    const cached = cachedClaudeCapabilityUsage(session.sessionId);
    if (cached) return cached;
    lines = claudeLogLines(session.sessionId);
  }
  if (!lines) return [];
  const pending = new Map<string, PendingCapabilityTool>();
  const out: CapabilityObservation[] = [];

  let commandOrdinal = 0;
  for (const line of lines) {
    const row = safeParse(line);
    if (!row) continue;
    const rowAt = ts(row.timestamp);
    // A skill the person invoked as a slash command never becomes a tool call;
    // the host writes it as a user turn. It is a skill used all the same.
    const command = slashCommandSkill(row);
    if (command) {
      commandOrdinal += 1;
      rememberCapabilityObservation(out, {
        sourceId: `${sourceThreadId}:command:${typeof row.uuid === "string" ? row.uuid : commandOrdinal}`,
        sessionId: session.sessionId,
        toolName: `/${command}`,
        skill: command,
        createdAt: rowAt || session.lastActivityAt,
        outcome: "success",
      });
      continue;
    }
    if (!Array.isArray(row.message?.content)) continue;
    for (const block of row.message.content as any[]) {
      if (
        block?.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        const item: PendingCapabilityTool = {
          sourceId: `${sourceThreadId}:${block.id}`,
          sessionId: session.sessionId,
          toolName: block.name,
          input: block.input,
          createdAt: rowAt || session.lastActivityAt,
          cwd: session.cwd ?? undefined,
        };
        for (const path of writtenPaths(item.toolName, item.input)) {
          recordObservedWrite(session.sessionId, path, item.createdAt);
        }
        if (pendingCapabilityObservation(item)) {
          rememberPendingCapabilityCall(pending, block.id, item);
        }
        continue;
      }
      if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") {
        continue;
      }
      const item = pending.get(block.tool_use_id);
      if (!item) continue;
      const observation =
        observeCapability(item, block.content, rowAt || item.createdAt, {
          outcome: block.is_error === true ? "error" : "success",
          errorClass: block.is_error === true ? "tool_result" : undefined,
        }, "claude") ??
        pendingCapabilityObservation(item);
      if (observation) rememberCapabilityObservation(out, observation);
      pending.delete(block.tool_use_id);
    }
  }

  for (const item of pending.values()) {
    const observation = pendingCapabilityObservation(item);
    if (observation) rememberCapabilityObservation(out, observation);
  }
  return out;
}

/**
 * Housekeeping commands are the terminal's own, not a skill anyone wrote:
 * counting `/clear` as a skill would put the tool's plumbing in the usage.
 */
const BUILTIN_COMMANDS = new Set([
  "clear", "compact", "help", "model", "cost", "status", "config", "doctor", "login", "logout",
  "memory", "permissions", "hooks", "mcp", "agents", "exit", "quit", "bug", "vim", "terminal-setup",
  "resume", "continue", "init", "context", "release-notes", "upgrade", "fast", "theme",
]);

/** The skill a user turn invoked as a slash command, when it is one. */
export function slashCommandSkill(row: any): string | undefined {
  if (row?.type !== "user" && row?.message?.role !== "user") return undefined;
  const content = row.message?.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.find((block: any) => block?.type === "text")?.text
      : undefined;
  if (typeof text !== "string" || !text.trimStart().startsWith("<command-name>")) return undefined;
  const name = /<command-name>\s*\/?([A-Za-z0-9][A-Za-z0-9_:.-]{0,79})\s*<\/command-name>/.exec(text)?.[1];
  if (!name || BUILTIN_COMMANDS.has(name.toLowerCase())) return undefined;
  return name;
}

function appendClaudeToolUse(input: {
  out: ActivityEntry[];
  seen: Set<string>;
  session: SessionInfo;
  observations: Map<string, CapabilityObservation>;
  patches: ReturnType<typeof patchStatsByToolUse>;
  childFields: ReturnType<typeof childEntryFields> | Record<string, never>;
  sourceThreadId: string;
  block: any;
  createdAt: number;
  index: number;
  blockIndex: number;
}): void {
  const {
    out, seen, session, observations, patches, childFields, sourceThreadId,
    block, createdAt, index, blockIndex,
  } = input;
  const classified = classifyTool(block.name, block.input);
  const sourceId =
    typeof block.id === "string"
      ? `${sourceThreadId}:${block.id}`
      : `${sourceThreadId}:${createdAt}:${index * 100 + blockIndex}`;
  const pending: PendingCapabilityTool = {
    sourceId,
    sessionId: session.sessionId,
    toolName: String(block.name ?? "tool"),
    input: block.input,
    createdAt,
    cwd: session.cwd ?? undefined,
  };
  const observation =
    observations.get(sourceId) ?? pendingCapabilityObservation(pending);
  const patch = typeof block.id === "string" ? patches.get(block.id) : undefined;
  const toolInput = block.input as Record<string, unknown> | undefined;
  const stats = patch?.stats ?? statsFromInput(String(block.name ?? ""), block.input);
  const diffPreview = stats && !sensitivePath(toolInput?.file_path ?? toolInput?.path)
    ? patch?.preview ?? diffPreviewFromInput(String(block.name ?? ""), block.input, redactSecrets)
    : undefined;
  pushEntry({ out: out, seen: seen, sessionId: session.sessionId, kind: "tool", text: toolSummary(block.name, block.input), createdAt: createdAt, ordinal: index * 100 + blockIndex, extras: {
      ...childFields,
      ...classified,
      ...(stats ?? {}),
      ...(diffPreview ? { diffPreview } : {}),
      ...(toolDescription(block.input) ? { summary: toolDescription(block.input) } : {}),
      ...(observation
        ? activityTelemetry(observation)
        : { estimatedContextTokens: estimateTokens(block.input) }),
    }, idOverride: observation ? sourceId : undefined });
}

function appendClaudeActivity(input: {
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
  // The size of a file change, from the patch the host wrote beside the
  // result, so a Write reads "+12 −3" and not only as a path.
  const patches = patchStatsByToolUse(lines, safeParse, redactSecrets);
  lines.forEach((line, index) => {
    const d = safeParse(line);
    if (!d) return;
    const createdAt = ts(d.timestamp) || session.lastActivityAt;
    const content = d.message?.content;
    if (d.type === "user" || d.message?.role === "user") {
      if (typeof content === "string") {
        pushEntry({ out: out, seen: seen, sessionId: session.sessionId, kind: "user", text: content, createdAt: createdAt, ordinal: index, extras: childFields });
      } else if (Array.isArray(content)) {
        content.forEach((block: any, blockIndex: number) => {
          // Tool results and system/reminder blocks are transport context, not
          // words the person typed. Only explicit visible text belongs in chat.
          if (block?.type === "text") {
            pushEntry({ out: out, seen: seen, sessionId: session.sessionId, kind: "user", text: block.text, createdAt: createdAt, ordinal: index * 100 + blockIndex, extras: childFields });
          }
        });
      }
      return;
    }
    if (d.type !== "assistant" && d.message?.role !== "assistant") return;
    if (typeof content === "string") {
      pushEntry({ out: out, seen: seen, sessionId: session.sessionId, kind: "message", text: content, createdAt: createdAt, ordinal: index, extras: childFields });
      return;
    }
    if (!Array.isArray(content)) return;
    content.forEach((block: any, blockIndex: number) => {
      if (block?.type === "text") {
        pushEntry({ out: out, seen: seen, sessionId: session.sessionId, kind: "message", text: block.text, createdAt: createdAt, ordinal: index * 100 + blockIndex, extras: childFields });
      } else if (block?.type === "tool_use") {
        appendClaudeToolUse({
          out, seen, session, observations, patches, childFields, sourceThreadId,
          block, createdAt, index, blockIndex,
        });
      }
    });
  });
}

export function claudeActivity(session: SessionInfo): ActivityEntry[] {
  const lines = claudeLogLines(session.sessionId);
  if (!lines) return [];
  const observations = new Map(
    claudeCapabilityUsage(session).map((item) => [item.sourceId, item]),
  );
  const out: ActivityEntry[] = [];
  const seen = new Set<string>();
  appendClaudeActivity({ out, seen, session, lines, observations });
  const childById = new Map(session.childThreads?.map((child) => [child.threadId, child]));
  for (const path of claudeChildLogPathsBySession.get(session.sessionId) ?? []) {
    const childLines = readLines(path);
    if (!childLines) continue;
    const inferred = claudeChildSummary(path, session.sessionId, childLines);
    const child = childById.get(inferred.threadId) ?? inferred;
    appendClaudeActivity({ out, seen, session, lines: childLines, observations, child });
  }
  // V8 sort is stable: preserve transcript order when a provider stamps a
  // whole batch with the same millisecond. Source ids are not chronological.
  return out.sort((a, b) => a.createdAt - b.createdAt);
}
