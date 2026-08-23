import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ActivityEntry, SessionInfo } from "../../../../packages/protocol/schema";
import {
  classifyTool,
  estimateTokens,
  pushEntry,
  toolSummary,
} from "./activity-helpers";
import {
  grokSessionsRoot,
  HISTORY_RETENTION_MS,
  MAX_FILES,
  safeParse,
  stateFor,
  TOKEN_WINDOW_MS,
  ts,
  type Scan,
} from "./common";
import type { CapabilityObservation } from "./telemetry";

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
  tokens: number;
  lastTurn: number;
};

let activityBySession = new Map<string, ActivityEntry[]>();
let usageBySession = new Map<string, CapabilityObservation[]>();

function recentSummaries(root: string): string[] {
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
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES).map((item) => item.path);
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

function parseLog(path: string, sessionId: string, fallbackTime: number): ParsedLog {
  let lines: string[];
  try { lines = readFileSync(path, "utf8").split("\n"); } catch {
    return { entries: [], usage: [], tokens: 0, lastTurn: 0 };
  }
  const entries: ActivityEntry[] = [];
  const usage: CapabilityObservation[] = [];
  const seen = new Set<string>();
  let firstUser: string | undefined;
  let tokens = 0;
  let lastTurn = 0;
  lines.forEach((line, index) => {
    const row = safeParse(line);
    if (!row) return;
    const message = row.message && typeof row.message === "object" ? row.message : row;
    const role = String(message.role ?? row.role ?? "");
    if (role === "reasoning" || role === "system") return;
    const createdAt = ts(row.timestamp ?? message.timestamp) || fallbackTime + index;
    const texts = textBlocks(message.content);
    if (role === "user") {
      const text = texts.join("\n").trim();
      if (text) {
        firstUser ??= text;
        pushEntry(entries, seen, sessionId, "user", text, createdAt, index);
        tokens += estimateTokens(text);
      }
      return;
    }
    if (role !== "assistant") return;
    let turnTokens = 0;
    texts.forEach((text, block) => {
      pushEntry(entries, seen, sessionId, "message", text, createdAt, index * 100 + block);
      turnTokens += estimateTokens(text);
    });
    const blocks = Array.isArray(message.content) ? message.content : [];
    blocks.forEach((block: Record<string, unknown>, blockIndex: number) => {
      if (block?.type !== "tool_use") return;
      const name = block.name;
      const input = block.input;
      const identity = classifyTool(name, input);
      const sourceId = String(block.id ?? `${sessionId}:${index}:${blockIndex}`);
      pushEntry(entries, seen, sessionId, "tool", toolSummary(name, input), createdAt,
        index * 100 + blockIndex, identity);
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
  return { entries, usage, firstUser, tokens, lastTurn };
}

function parseSummary(path: string): Summary | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as Summary; } catch { return null; }
}

export function scanGrok(): Scan {
  const sessions: SessionInfo[] = [];
  const activities = new Map<string, ActivityEntry[]>();
  const usages = new Map<string, CapabilityObservation[]>();
  let tokensRecent = 0;
  for (const path of recentSummaries(grokSessionsRoot())) {
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
    const parsed = parseLog(join(directory, "chat_history.jsonl"), sessionId, stat.mtimeMs);
    const updatedAt = ts(summary.updated_at) || stat.mtimeMs;
    const startedAt = ts(summary.created_at) || stat.birthtimeMs || updatedAt;
    const title = [summary.generated_title, summary.session_summary, parsed.firstUser]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    const cwd = typeof summary.info?.cwd === "string" ? summary.info.cwd : undefined;
    sessions.push({
      sessionId, agent: "grok", title: title?.trim().slice(0, 120), cwd,
      model: typeof summary.current_model_id === "string" ? summary.current_model_id : undefined,
      state: stateFor(updatedAt), startedAt, lastActivityAt: updatedAt,
      tokensSession: parsed.tokens, tokensLastTurn: parsed.lastTurn,
      contextTokensUsed: parsed.tokens,
    });
    activities.set(sessionId, parsed.entries);
    usages.set(sessionId, parsed.usage);
    if (Date.now() - updatedAt <= TOKEN_WINDOW_MS) tokensRecent += parsed.tokens;
  }
  activityBySession = activities;
  usageBySession = usages;
  return { sessions, tokensRecent };
}

export function grokActivity(session: SessionInfo): ActivityEntry[] {
  if (!activityBySession.has(session.sessionId)) scanGrok();
  return activityBySession.get(session.sessionId) ?? [];
}

export function grokCapabilityUsage(session: SessionInfo): CapabilityObservation[] {
  if (!usageBySession.has(session.sessionId)) scanGrok();
  return usageBySession.get(session.sessionId) ?? [];
}
