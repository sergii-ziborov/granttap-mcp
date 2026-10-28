import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ActivityEntry, SessionInfo } from "../../../../../packages/protocol/schema";
import {
  classifyTool,
  estimateTokens,
  pushEntry,
} from "../support/activity-helpers";
import {
  grokSessionsRoot,
  HISTORY_RETENTION_MS,
  MAX_FILES,
  safeParse,
  stateFor,
  TOKEN_WINDOW_MS,
  ts,
  type Scan,
} from "../support/common";
import type { CapabilityObservation } from "../telemetry";
import { grokNativeActivity } from '../../providers/grok-activity';
import { grokTimeline } from '../../providers/grok-timeline';
import { grokToolCalls, grokToolCompletions, grokToolSummary, grokRecordedChanges } from '../../providers/grok-tools';

type Summary = {
  info?: { id?: unknown; cwd?: unknown };
  generated_title?: unknown;
  session_summary?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  current_model_id?: unknown;
};

type ParsedLog = {
  entries: ActivityEntry[];
  usage: CapabilityObservation[];
  firstUser?: string;
  lastMessageAt?: number;
  tokens: number;
  lastTurn: number;
};

let activityBySession = new Map<string, ActivityEntry[]>();
let logPaths = new Map<string, string>();
let usageBySession = new Map<string, CapabilityObservation[]>();

function recentSummaries(root: string, limit: number): string[] {
  const found: Array<{ path: string; mtime: number }> = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      let stat;
      try { stat = statSync(path); } catch { continue; }
      if (stat.isDirectory()) walk(path, depth + 1);
      else if (name === "summary.json" && Date.now() - stat.mtimeMs <= HISTORY_RETENTION_MS) {
        found.push({ path, mtime: stat.mtimeMs });
      }
    }
  };
  walk(root, 0);
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((item) => item.path);
}

function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const value = block as Record<string, unknown>;
    return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
  });
}

function visibleRole(row: Record<string, unknown>, message: Record<string, unknown>): string {
  if (row.synthetic_reason != null || message.synthetic_reason != null) return "";
  const role = message.role ?? row.role;
  if (role != null) return String(role);
  const type = message.type ?? row.type;
  const index = message.prompt_index ?? row.prompt_index;
  if (type === "user" && (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0)) return "";
  return typeof type === "string" ? type : "";
}

function parseLog(path: string, sessionId: string, fallbackTime: number, fullText = false): ParsedLog {
  let lines: string[];
  try { lines = readFileSync(path, "utf8").split("\n"); } catch {
    return { entries: [], usage: [], tokens: 0, lastTurn: 0 };
  }
  const entries: ActivityEntry[] = [];
  const usage: CapabilityObservation[] = [];
  const seen = new Set<string>();
  let firstUser: string | undefined;
  let lastMessageAt = 0;
  let tokens = 0;
  let lastTurn = 0;
  const timeline = grokTimeline(dirname(path));
  const completions = grokToolCompletions(dirname(path));
  let prompt: { at: number; row: number } | undefined;
  lines.forEach((line, index) => {
    const row = safeParse(line);
    if (!row) return;
    const message = row.message && typeof row.message === "object" ? row.message : row;
    const role = visibleRole(row, message);
    if (role === "reasoning" || role === "system") return;
    const messageAt = ts(row.timestamp ?? message.timestamp);
    const legacyTime = messageAt || fallbackTime + index;
    const indexValue = message.prompt_index ?? row.prompt_index;
    const indexedUser = (message.role ?? row.role ?? message.type ?? row.type) === 'user'
      && typeof indexValue === 'number' && Number.isSafeInteger(indexValue) && indexValue >= 0;
    if (role === 'user' || indexedUser) {
      const at = messageAt || (indexedUser ? timeline.prompts.get(indexValue as number) : undefined);
      if (role === 'user' || at) prompt = at ? { at, row: index } : undefined;
    }
    const createdAt = messageAt || (prompt ? prompt.at + index - prompt.row : legacyTime);
    const texts = textBlocks(message.content);
    if (role === "user") {
      const text = texts.join("\n").trim();
      if (text) {
        if (messageAt || prompt) lastMessageAt = Math.max(lastMessageAt, createdAt);
        firstUser ??= text;
        pushEntry({ fullText, out: entries, seen, sessionId, kind: "user", text, createdAt, ordinal: index,
          idOverride: `${sessionId}:${legacyTime}:${index}` });
        tokens += estimateTokens(text);
      }
      return;
    }
    if (role !== "assistant") return;
    let turnTokens = 0;
    texts.forEach((text, block) => {
      pushEntry({ fullText, out: entries, seen, sessionId, kind: "message", text, createdAt, ordinal: index * 100 + block,
        idOverride: `${sessionId}:${legacyTime}:${index * 100 + block}` });
      turnTokens += estimateTokens(text);
    });
    if (texts.some((text) => !!text.trim()) && (messageAt || prompt)) {
      lastMessageAt = Math.max(lastMessageAt, createdAt);
    }
    grokToolCalls(message).forEach((call) => {
      const name = call.name;
      const input = call.input;
      const identity = classifyTool(name, input);
      const sourceId = call.id ?? `${sessionId}:${index}:${call.ordinal}`;
      const fileChanges = grokRecordedChanges(call, call.id ? completions.get(call.id) : undefined);
      const idOverride = call.typed ? `${sessionId}:tool:${sourceId}`
        : `${sessionId}:${legacyTime}:${index * 100 + call.ordinal}`;
      pushEntry({ fullText, out: entries, seen, sessionId, kind: "tool", text: grokToolSummary(call),
        createdAt, ordinal: index * 100 + call.ordinal,
        extras: { ...identity, ...(fileChanges.length ? { fileChanges } : {}) }, idOverride });
      usage.push({
        sourceId, sessionId, toolName: identity.toolName, createdAt,
        mcpServer: identity.mcpServer, skill: identity.skill,
        cli: identity.mcpServer || identity.skill ? undefined : true,
        estimatedContextTokens: estimateTokens(input) || undefined, outcome: "unknown",
      });
      turnTokens += estimateTokens(input);
    });
    tokens += turnTokens;
    if (turnTokens > 0) lastTurn = turnTokens;
  });
  const last = entries.at(-1);
  if (prompt && last?.kind === 'message' && timeline.completedAt && timeline.completedAt >= last.createdAt) {
    last.kind = 'final'; last.createdAt = timeline.completedAt;
    lastMessageAt = Math.max(lastMessageAt, timeline.completedAt);
  }
  return { entries, usage, firstUser, lastMessageAt: lastMessageAt || undefined, tokens, lastTurn };
}

function parseSummary(path: string): Summary | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as Summary; } catch { return null; }
}

export function scanGrok(maxFiles = MAX_FILES): Scan {
  const sessions: SessionInfo[] = [];
  const activities = new Map<string, ActivityEntry[]>();
  const usages = new Map<string, CapabilityObservation[]>();
  let tokensRecent = 0;
  const listed = recentSummaries(grokSessionsRoot(), maxFiles + 1);
  for (const path of listed.slice(0, maxFiles)) {
    const summary = parseSummary(path);
    if (!summary) continue;
    const directory = dirname(path);
    const sessionId = typeof summary.info?.id === "string"
      ? summary.info.id : basename(directory);
    if (!sessionId || sessionId.length > 256) continue;
    let stat;
    try { stat = statSync(join(directory, "chat_history.jsonl")); } catch {
      try { stat = statSync(path); } catch { continue; }
    }
    const updatedAt = ts(summary.updated_at) || stat.mtimeMs;
    const startedAt = ts(summary.created_at) || stat.birthtimeMs || updatedAt;
    const parsed = parseLog(join(directory, "chat_history.jsonl"), sessionId, startedAt);
    const title = [summary.generated_title, summary.session_summary, parsed.firstUser]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    const cwd = typeof summary.info?.cwd === "string" ? summary.info.cwd : undefined;
    const live = grokNativeActivity(sessionId, directory);
    sessions.push({
      sessionId, agent: "grok", title: title?.trim().slice(0, 120), cwd,
      model: typeof summary.current_model_id === "string" ? summary.current_model_id : undefined,
      state: live?.state ?? stateFor(updatedAt), startedAt, lastActivityAt: Math.max(updatedAt, live?.updatedAt ?? 0),
      ...(parsed.lastMessageAt ? { lastMessageAt: parsed.lastMessageAt } : {}),
      tokensSession: parsed.tokens, tokensLastTurn: parsed.lastTurn,
      contextTokensUsed: parsed.tokens,
    });
    logPaths.set(sessionId, join(directory, "chat_history.jsonl"));
    activities.set(sessionId, parsed.entries);
    usages.set(sessionId, parsed.usage);
    if (Date.now() - updatedAt <= TOKEN_WINDOW_MS) tokensRecent += parsed.tokens;
  }
  activityBySession = activities;
  usageBySession = usages;
  return { sessions, tokensRecent, sourceLimited: listed.length > maxFiles };
}

export function grokActivity(session: SessionInfo, fullText = false): ActivityEntry[] {
  if (!activityBySession.has(session.sessionId)) scanGrok();
  const path = logPaths.get(session.sessionId);
  if (fullText && path) return parseLog(path, session.sessionId, session.startedAt, true).entries;
  return activityBySession.get(session.sessionId) ?? [];
}

export function grokCapabilityUsage(session: SessionInfo): CapabilityObservation[] {
  if (!usageBySession.has(session.sessionId)) scanGrok();
  return usageBySession.get(session.sessionId) ?? [];
}
