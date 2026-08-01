/**
 * Reads recent Claude Code and Codex session logs. Only user-visible assistant
 * messages and compact tool summaries leave the machine; reasoning blocks are
 * deliberately ignored.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ActivityEntry,
  SessionActivity,
  SessionInfo,
  SessionState,
} from "../../../packages/protocol/schema";

const WORKING_MS = 90_000;
const STALE_MS = 12 * 60 * 60 * 1000;
export const TOKEN_WINDOW_HOURS = STALE_MS / (60 * 60 * 1000);
const MAX_FILES = 40;
const HISTORY_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_HISTORY_FILES = 160;

type Scan = { sessions: SessionInfo[]; tokensRecent: number };

function stateFor(lastActivityAt: number): SessionState {
  const age = Date.now() - lastActivityAt;
  if (age <= WORKING_MS) return "working";
  if (age <= 30 * 60_000) return "waiting";
  return "idle";
}

function safeParse(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function timestamp(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function recentLogs(root: string, depth = 4, maxAge = STALE_MS, maxFiles = MAX_FILES): string[] {
  const out: { path: string; mtime: number }[] = [];
  const walk = (dir: string, level: number): void => {
    if (level > depth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full, level + 1);
      else if (name.endsWith(".jsonl") && Date.now() - stat.mtimeMs <= maxAge) {
        out.push({ path: full, mtime: stat.mtimeMs });
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, maxFiles).map((file) => file.path);
}

function claudeProjectsRoot(): string {
  return (
    process.env.GRANTTAP_CLAUDE_PROJECTS_DIR ??
    process.env.NODVOX_CLAUDE_PROJECTS_DIR ??
    join(homedir(), ".claude", "projects")
  );
}

function codexSessionsRoot(): string {
  return (
    process.env.GRANTTAP_CODEX_SESSIONS_DIR ??
    process.env.NODVOX_CODEX_SESSIONS_DIR ??
    join(homedir(), ".codex", "sessions")
  );
}

function sumClaudeUsage(usage: any): number {
  if (!usage || typeof usage !== "object") return 0;
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

function claudeContextUsage(usage: any): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const values = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens];
  if (!values.some((value) => typeof value === "number")) return undefined;
  return values.reduce<number>((sum, value) => sum + (typeof value === "number" ? value : 0), 0);
}

/**
 * Codex's `total_tokens` includes the entire cached prompt on every model call.
 * In a long thread that can turn a few hundred thousand new tokens into tens
 * of millions even though almost all of them were cache reads. GrantTap shows
 * newly processed tokens, matching the Claude calculation and the number a
 * person expects when judging session size.
 */
function effectiveCodexUsage(usage: any): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const total = usage.total_tokens;
  if (typeof total !== "number" || !Number.isFinite(total)) return undefined;
  const cached = typeof usage.cached_input_tokens === "number" && Number.isFinite(usage.cached_input_tokens)
    ? usage.cached_input_tokens
    : 0;
  return Math.max(0, total - cached);
}

function scanClaude(maxAge = STALE_MS, maxFiles = MAX_FILES): Scan {
  const sessions: SessionInfo[] = [];
  let tokensRecent = 0;

  for (const file of recentLogs(claudeProjectsRoot(), 2, maxAge, maxFiles)) {
    let lines: string[];
    try {
      lines = readFileSync(file, "utf8").split("\n");
    } catch {
      continue;
    }
    let sessionId = "";
    let cwd: string | undefined;
    let branch: string | undefined;
    let model: string | undefined;
    let title: string | undefined;
    let summary: string | undefined;
    let startedAt = 0;
    let lastActivityAt = 0;
    let tokensSession = 0;
    let tokensLastTurn = 0;
    let contextTokensUsed: number | undefined;

    for (const line of lines) {
      if (!line) continue;
      const data = safeParse(line);
      if (!data) continue;
      if (data.sessionId && !sessionId) sessionId = String(data.sessionId);
      if (data.cwd && !cwd) cwd = String(data.cwd);
      if (data.gitBranch && !branch) branch = String(data.gitBranch);
      if (data.type === "ai-title" && typeof data.content === "string" && !title) title = data.content;
      const at = timestamp(data.timestamp);
      if (at) {
        if (!startedAt || at < startedAt) startedAt = at;
        if (at > lastActivityAt) lastActivityAt = at;
      }
      const usage = data?.message?.usage;
      if (usage) {
        const spent = sumClaudeUsage(usage);
        tokensSession += spent;
        tokensLastTurn = spent;
        contextTokensUsed = claudeContextUsage(usage) ?? contextTokensUsed;
        if (data.message?.model && !model) model = String(data.message.model);
      }
      if (data.message?.role === "assistant") {
        const content = data.message.content;
        if (typeof content === "string" && compact(content)) summary = compact(content, 180);
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "text" && compact(block.text)) summary = compact(block.text, 180);
          }
        }
      }
    }

    if (!sessionId || !lastActivityAt) continue;
    tokensRecent += tokensSession;
    sessions.push({
      sessionId,
      agent: "claude",
      title,
      cwd,
      branch,
      model,
      summary,
      state: stateFor(lastActivityAt),
      startedAt: startedAt || lastActivityAt,
      lastActivityAt,
      tokensSession,
      tokensLastTurn,
      contextTokensUsed,
    });
  }
  return { sessions, tokensRecent };
}

function scanCodex(maxAge = STALE_MS, maxFiles = MAX_FILES): Scan {
  const sessions: SessionInfo[] = [];
  let tokensRecent = 0;

  for (const file of recentLogs(codexSessionsRoot(), 5, maxAge, maxFiles)) {
    let lines: string[];
    try {
      lines = readFileSync(file, "utf8").split("\n");
    } catch {
      continue;
    }
    let sessionId = "";
    let cwd: string | undefined;
    let branch: string | undefined;
    let model: string | undefined;
    let title: string | undefined;
    let summary: string | undefined;
    let accessLevel: SessionInfo["accessLevel"];
    let startedAt = 0;
    let lastActivityAt = 0;
    let tokensSession = 0;
    let tokensLastTurn = 0;
    let contextTokensUsed: number | undefined;
    let contextWindow: number | undefined;

    for (const line of lines) {
      if (!line) continue;
      const data = safeParse(line);
      if (!data) continue;
      const at = timestamp(data.timestamp);
      if (at) {
        if (!startedAt || at < startedAt) startedAt = at;
        if (at > lastActivityAt) lastActivityAt = at;
      }
      if (data.type === "session_meta") {
        const payload = data.payload ?? data;
        if (payload?.id) sessionId = String(payload.id);
        if (payload?.cwd) cwd = String(payload.cwd);
        if (payload?.model) model = String(payload.model);
        if (payload?.git?.branch) branch = String(payload.git.branch);
        if (typeof payload?.title === "string") title = payload.title;
      }
      if (data.type === "turn_context" && data.payload?.model) model = String(data.payload.model);
      if (data.type === "turn_context") {
        const sandbox = data.payload?.sandbox_policy?.type;
        if (sandbox === "read-only") accessLevel = "read-only";
        if (sandbox === "workspace-write") accessLevel = "workspace";
        if (sandbox === "danger-full-access") accessLevel = "full";
      }
      if (data.type === "event_msg" && data.payload?.type === "token_count") {
        const info = data.payload.info ?? {};
        const total = effectiveCodexUsage(info.total_token_usage);
        const last = effectiveCodexUsage(info.last_token_usage);
        if (total != null) tokensSession = total;
        if (last != null) tokensLastTurn = last;
        const input = info.last_token_usage?.input_tokens;
        if (typeof input === "number" && Number.isFinite(input)) contextTokensUsed = input;
        const window = info.model_context_window;
        if (typeof window === "number" && Number.isFinite(window)) contextWindow = window;
      }
      if (data.type === "event_msg" && data.payload?.type === "agent_message") {
        const message = data.payload.message ?? data.payload.text;
        if (compact(message)) summary = compact(message, 180);
      }
      if (data.type === "response_item") {
        const payload = data.payload ?? {};
        if (payload.type === "message" && payload.role === "assistant" && Array.isArray(payload.content)) {
          for (const block of payload.content) {
            if (["output_text", "text"].includes(block?.type) && compact(block.text)) {
              summary = compact(block.text, 180);
            }
          }
        }
      }
      if (!title && data.type === "event_msg" && data.payload?.type === "user_message") {
        const message = data.payload.message ?? data.payload.text;
        if (typeof message === "string") title = compact(message, 80);
      }
    }

    if (!lastActivityAt) continue;
    if (!sessionId) sessionId = file.split("/").pop()?.replace(".jsonl", "") ?? "codex";
    tokensRecent += tokensSession;
    sessions.push({
      sessionId,
      agent: "codex",
      title,
      cwd,
      branch,
      model,
      summary,
      accessLevel,
      state: stateFor(lastActivityAt),
      startedAt: startedAt || lastActivityAt,
      lastActivityAt,
      tokensSession,
      tokensLastTurn,
      contextTokensUsed,
      contextWindow,
    });
  }
  return { sessions, tokensRecent };
}

export function scanSessions(): { sessions: SessionInfo[]; tokensRecent: number } {
  const claude = scanClaude();
  const codex = scanCodex();
  const sessions = [...claude.sessions, ...codex.sessions].sort((a, b) => {
    const rank = { working: 0, waiting: 1, idle: 2 } as const;
    if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
    return b.lastActivityAt - a.lastActivityAt;
  });
  return { sessions, tokensRecent: claude.tokensRecent + codex.tokensRecent };
}

/** Bounded local history. Token totals are per chat; this does not affect the recent-usage counter. */
export function scanSessionHistory(): SessionInfo[] {
  const claude = scanClaude(HISTORY_MS, MAX_HISTORY_FILES);
  const codex = scanCodex(HISTORY_MS, MAX_HISTORY_FILES);
  const byId = new Map<string, SessionInfo>();
  for (const session of [...claude.sessions, ...codex.sessions]) {
    const previous = byId.get(session.sessionId);
    if (!previous || session.lastActivityAt > previous.lastActivityAt) byId.set(session.sessionId, session);
  }
  return [...byId.values()]
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, MAX_HISTORY_FILES);
}

const MAX_ACTIVITY_ENTRIES = 120;
const MAX_ACTIVITY_TEXT = 4_000;

function compact(value: unknown, max = MAX_ACTIVITY_TEXT): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function activityText(value: unknown, max = MAX_ACTIVITY_TEXT): string {
  const text = String(value ?? "").replace(/\r\n/g, "\n").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function toolSummary(name: unknown, input: unknown): string {
  const tool = compact(name || "tool", 80);
  if (typeof input === "string") return `${tool}: ${compact(input, 420)}`;
  if (!input || typeof input !== "object") return tool;
  const fields = input as Record<string, unknown>;
  const detail =
    fields.command ?? fields.cmd ?? fields.file_path ?? fields.path ?? fields.url ?? fields.query ?? fields.description;
  return detail == null ? tool : `${tool}: ${compact(detail, 420)}`;
}

type ToolMetadata = Pick<ActivityEntry, "toolName" | "mcpServer" | "skill">;

function toolMetadata(name: unknown, input: unknown): ToolMetadata {
  const toolName = compact(name || "tool", 180);
  const parts = toolName.split("__");
  const mcpServer = parts[0] === "mcp" && parts.length >= 3 ? compact(parts[1], 180) : undefined;
  let skill: string | undefined;
  if (toolName.toLowerCase() === "skill" && input && typeof input === "object") {
    const fields = input as Record<string, unknown>;
    const candidate = fields.skill ?? fields.name;
    if (typeof candidate === "string" && candidate.trim()) skill = compact(candidate, 180);
  }
  return { toolName, mcpServer, skill };
}

function pushEntry(
  out: ActivityEntry[],
  seen: Set<string>,
  sessionId: string,
  kind: ActivityEntry["kind"],
  text: unknown,
  createdAt: number,
  ordinal: number,
  metadata: ToolMetadata = {},
): void {
  const visible = kind === "user" ? visibleUserText(text) : text;
  const clean = activityText(visible);
  if (!clean) return;
  const duplicate = `${kind}:${clean}`;
  if (seen.has(duplicate)) return;
  seen.add(duplicate);
  out.push({ id: `${sessionId}:${createdAt}:${ordinal}`, kind, text: clean, createdAt, ...metadata });
}

/** Remove host-injected context that is not a message the person typed. */
function visibleUserText(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const internal = [
    "recommended_plugins",
    "environment_context",
    "app-context",
    "permissions instructions",
    "collaboration_mode",
    "apps_instructions",
    "plugins_instructions",
    "skills_instructions",
  ];
  if (internal.some((tag) => text.startsWith(`<${tag}`)) || text.startsWith("<image name=")) return "";
  const requestMarker = "## My request for Codex:";
  const marker = text.indexOf(requestMarker);
  if (marker >= 0) return text.slice(marker + requestMarker.length).trim();
  return text;
}

function claudeActivity(session: SessionInfo): ActivityEntry[] {
  const file = recentLogs(claudeProjectsRoot(), 2, HISTORY_MS, MAX_HISTORY_FILES)
    .find((path) => path.endsWith(`/${session.sessionId}.jsonl`));
  if (!file) return [];
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").split("\n");
  } catch {
    return [];
  }
  const out: ActivityEntry[] = [];
  const seen = new Set<string>();
  lines.forEach((line, index) => {
    const data = safeParse(line);
    if (!data) return;
    const role = data.message?.role ?? data.type;
    if (role !== "user" && role !== "assistant") return;
    const createdAt = timestamp(data.timestamp) || session.lastActivityAt;
    const content = data.message?.content;
    if (typeof content === "string") {
      pushEntry(out, seen, session.sessionId, role === "user" ? "user" : "message", content, createdAt, index);
      return;
    }
    if (!Array.isArray(content)) return;
    content.forEach((block: any, blockIndex: number) => {
      if (block?.type === "text") {
        pushEntry(
          out,
          seen,
          session.sessionId,
          role === "user" ? "user" : "message",
          block.text,
          createdAt,
          index * 100 + blockIndex,
        );
      } else if (role === "assistant" && block?.type === "tool_use") {
        pushEntry(
          out,
          seen,
          session.sessionId,
          "tool",
          toolSummary(block.name, block.input),
          createdAt,
          index * 100 + blockIndex,
          toolMetadata(block.name, block.input),
        );
      }
    });
  });
  return out;
}

function codexActivity(session: SessionInfo): ActivityEntry[] {
  let lines: string[] | undefined;
  for (const file of recentLogs(codexSessionsRoot(), 5, HISTORY_MS, MAX_HISTORY_FILES)) {
    try {
      const candidate = readFileSync(file, "utf8").split("\n");
      if (
        candidate.some((line) => {
          const data = safeParse(line);
          return data?.type === "session_meta" && String(data.payload?.id ?? data.id ?? "") === session.sessionId;
        })
      ) {
        lines = candidate;
        break;
      }
    } catch {
      // Keep looking through the bounded recent-file set.
    }
  }
  if (!lines) return [];

  const out: ActivityEntry[] = [];
  const seen = new Set<string>();
  lines.forEach((line, index) => {
    const data = safeParse(line);
    if (!data) return;
    const payload = data.payload ?? {};
    const createdAt = timestamp(data.timestamp) || session.lastActivityAt;
    if (data.type === "event_msg" && payload.type === "user_message") {
      pushEntry(out, seen, session.sessionId, "user", payload.message ?? payload.text, createdAt, index);
      return;
    }
    if (data.type === "event_msg" && payload.type === "agent_message") {
      pushEntry(out, seen, session.sessionId, "message", payload.message ?? payload.text, createdAt, index);
      return;
    }
    if (data.type !== "response_item") return;
    if (payload.type === "message" && ["user", "assistant"].includes(payload.role) && Array.isArray(payload.content)) {
      payload.content.forEach((block: any, blockIndex: number) => {
        if (["input_text", "output_text", "text"].includes(block?.type)) {
          pushEntry(
            out,
            seen,
            session.sessionId,
            payload.role === "user" ? "user" : "message",
            block.text,
            createdAt,
            index * 100 + blockIndex,
          );
        }
      });
    } else if (["function_call", "custom_tool_call", "local_shell_call"].includes(payload.type)) {
      let args: unknown = payload.arguments ?? payload.input ?? payload.action;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          // Retain the compact raw form.
        }
      }
      const name = payload.name ?? payload.type;
      pushEntry(out, seen, session.sessionId, "tool", toolSummary(name, args), createdAt, index,
        toolMetadata(name, args));
    }
  });
  return out;
}

export function scanSessionActivity(session: SessionInfo): SessionActivity {
  const all = session.agent === "claude" ? claudeActivity(session) : codexActivity(session);
  let entries = all.slice(-MAX_ACTIVITY_ENTRIES);
  if (session.state !== "working") {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index]?.kind === "message") {
        entries[index] = { ...entries[index]!, kind: "final" };
        break;
      }
    }
  }
  return {
    type: "session.activity",
    sessionId: session.sessionId,
    agent: session.agent,
    state: session.state,
    entries,
    generatedAt: Date.now(),
  };
}
