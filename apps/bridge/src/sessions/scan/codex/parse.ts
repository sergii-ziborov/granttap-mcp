import { statSync } from "node:fs";
import {
  codexChildSource,
  codexSummaryCache,
  effectiveCodexUsage,
  observedCodexWorktree,
  readCodexLogWindow,
  workdirsFromCodexCall,
  type CodexCandidate,
  type CodexChildSource,
} from "./shared";
import { codexCapabilityUsage } from "./activity";
import { safeParse, stateFor, ts } from "../../support/common";
import type { SessionInfo } from "../../../../../../packages/protocol/schema";
import { childTitle } from "../../support/child-threads";
import { visibleUserText } from "../../support/activity-helpers";
import { codexHeadRequest } from "../../support/codex-head";

type CodexParseState = {
  sessionId: string;
  cwd?: string;
  branch?: string;
  model?: string;
  title?: string;
  summary?: string;
  accessLevel?: SessionInfo["accessLevel"];
  child?: CodexChildSource;
  startedAt: number;
  lastActivityAt: number;
  tokensSession: number;
  tokensLastTurn: number;
  contextTokensUsed?: number;
  contextWindow?: number;
  workdirs: string[];
};

function applyCodexLine(d: any, state: CodexParseState): void {
  state.workdirs.push(...workdirsFromCodexCall(d));
  const t = ts(d.timestamp);
  if (t) {
    if (!state.startedAt || t < state.startedAt) state.startedAt = t;
    if (t > state.lastActivityAt) state.lastActivityAt = t;
  }

  if (d.type === "session_meta") {
    const p = d.payload ?? d;
    if (p?.id) state.sessionId = String(p.id);
    if (p?.cwd) state.cwd = String(p.cwd);
    if (p?.model) state.model = String(p.model);
    if (p?.git?.branch) state.branch = String(p.git.branch);
    if (typeof p?.title === "string" && p.title.trim()) state.title = p.title.trim().slice(0, 120);
    state.child = codexChildSource(p);
  }

  if (d.type === "turn_context") {
    if (d.payload?.model) state.model = String(d.payload.model);
    const sandbox = d.payload?.sandbox_policy?.type;
    if (sandbox === "read-only") state.accessLevel = "read-only";
    if (sandbox === "workspace-write") state.accessLevel = "workspace";
    if (sandbox === "danger-full-access") state.accessLevel = "full";
  }

  if (!state.title && d.type === "event_msg" && d.payload?.type === "user_message") {
    state.title = childTitle(visibleUserText(d.payload.message ?? d.payload.text));
  }
  if (
    !state.title &&
    d.type === "response_item" &&
    d.payload?.type === "message" &&
    d.payload?.role === "user" &&
    Array.isArray(d.payload.content)
  ) {
    const visible = d.payload.content
      .filter((block: any) => block?.type === "input_text" || block?.type === "text")
      .map((block: any) => visibleUserText(block.text))
      .filter(Boolean)
      .join("\n");
    if (visible) state.title = childTitle(visible);
  }

  if (d.type === "event_msg" && d.payload?.type === "agent_message") {
    state.summary = childTitle(d.payload.message ?? d.payload.text)?.slice(0, 180);
  }
  if (
    d.type === "response_item" &&
    d.payload?.type === "message" &&
    d.payload?.role === "assistant" &&
    Array.isArray(d.payload.content)
  ) {
    for (const block of d.payload.content) {
      if (["output_text", "text"].includes(block?.type) && typeof block.text === "string") {
        state.summary = childTitle(block.text)?.slice(0, 180);
      }
    }
  }

  if (d.type === "event_msg" && d.payload?.type === "token_count") {
    const info = d.payload.info ?? {};
    const total = effectiveCodexUsage(info.total_token_usage);
    const last = effectiveCodexUsage(info.last_token_usage);
    if (total != null) state.tokensSession = total;
    if (last != null) state.tokensLastTurn = last;
    const input = info.last_token_usage?.input_tokens;
    if (typeof input === "number" && Number.isFinite(input)) state.contextTokensUsed = input;
    const window = info.model_context_window;
    if (typeof window === "number" && Number.isFinite(window)) state.contextWindow = window;
  }
}

export function parseCodexFile(file: string): CodexCandidate | undefined {
  let fileStat;
  try {
    fileStat = statSync(file);
  } catch {
    return undefined;
  }
  const cached = codexSummaryCache.get(file);
  if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
    return {
      file,
      session: { ...cached.session, state: stateFor(cached.session.lastActivityAt) },
      observations: cached.observations,
      child: cached.child,
    };
  }
  let lines: string[];
  try {
    lines = readCodexLogWindow(file);
  } catch {
    return undefined;
  }
  const state: CodexParseState = {
    sessionId: "", startedAt: 0, lastActivityAt: 0,
    tokensSession: 0, tokensLastTurn: 0, workdirs: [],
  };
  for (const line of lines) {
    if (!line) continue;
    const d = safeParse(line);
    if (d) applyCodexLine(d, state);
  }
  if (!state.title) state.title = childTitle(codexHeadRequest(file)?.text);
  state.lastActivityAt = Math.max(state.lastActivityAt, fileStat.mtimeMs);
  state.startedAt ||= fileStat.birthtimeMs || state.lastActivityAt;
  if (!state.sessionId) state.sessionId = file.split("/").pop()?.replace(".jsonl", "") ?? "codex";
  const session: SessionInfo = {
    sessionId: state.sessionId,
    agent: "codex",
    title: state.title,
    cwd: state.cwd,
    worktree: state.cwd ? observedCodexWorktree(state.cwd, state.workdirs) : undefined,
    branch: state.branch,
    model: state.model,
    summary: state.summary,
    accessLevel: state.accessLevel,
    state: stateFor(state.lastActivityAt),
    startedAt: state.startedAt || state.lastActivityAt,
    lastActivityAt: state.lastActivityAt,
    tokensSession: state.tokensSession,
    tokensLastTurn: state.tokensLastTurn,
    contextTokensUsed: state.contextTokensUsed,
    contextWindow: state.contextWindow,
  };
  const observations = codexCapabilityUsage(session, lines);
  const child = state.child;
  codexSummaryCache.set(file, {
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    session,
    tokensSession: state.tokensSession,
    observations,
    child,
  });
  return { file, session, observations, child };
}
