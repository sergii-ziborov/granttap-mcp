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
import { safeParse, ts } from "../../support/common";
import { codexTurnState, observeCodexTurn, type CodexTurnClock } from "./turn-state";
import type { SessionInfo } from "../../../../../../packages/protocol/schema";
import { childTitle } from "../../support/child-threads";
import { visibleUserText } from "../../support/activity-helpers";
import { codexHeadRequest, isProvisionalPageTitle } from "../../support/codex-head";
import { heartbeatDisplayText } from '../../host-heartbeat';
import { codexContextReport } from "../../context-usage";
import { codexRequestTitle } from '../../native-task-titles';
import { plainPreview } from '../../plain-preview';
import { createCodexLineageCalls, promptLead, type LineageCalls, type LineageFact, type PromptLead } from '../../../started-by';

type CodexParseState = {
  sessionId: string;
  cwd?: string;
  branch?: string;
  model?: string;
  effort?: SessionInfo['effort'];
  title?: string;
  provisionalTitle?: string;
  summary?: string;
  accessLevel?: SessionInfo["accessLevel"];
  child?: CodexChildSource;
  startedAt: number;
  lastActivityAt: number;
  lastMessageAt: number;
  tokensSession: number;
  tokensLastTurn: number;
  contextTokensUsed?: number;
  contextWindow?: number;
  contextUsage?: SessionInfo["contextUsage"];
  workdirs: string[];
  turn: CodexTurnClock;
  /** `codex exec`: started by a command, not at a terminal. */
  headless?: boolean;
  /** The opening of the first request, once it was seen; for finding the chat that started this one. */
  prompt?: PromptLead | null;
  calls: LineageCalls;
};

/** The first visible request is the one a parent's command carried; later ones are not looked at. */
function notePrompt(state: CodexParseState, text: string | undefined): void {
  if (state.prompt === undefined && text) state.prompt = promptLead(text) ?? null;
}

function adoptRequestTitle(state: CodexParseState, text: string | undefined): void {
  const title = codexRequestTitle(text);
  if (!title) return;
  if (isProvisionalPageTitle(title)) state.provisionalTitle ??= title;
  else state.title = title;
}

function applyCodexLine(d: any, state: CodexParseState): void {
  observeCodexTurn(d, state.turn);
  state.calls.add(d);
  state.workdirs.push(...workdirsFromCodexCall(d));
  state.workdirs = state.workdirs.slice(-64);
  const t = ts(d.timestamp);
  if (t) {
    if (!state.startedAt || t < state.startedAt) state.startedAt = t;
    if (t > state.lastActivityAt) state.lastActivityAt = t;
    const eventMessage = d.type === "event_msg"
      && ["user_message", "agent_message"].includes(d.payload?.type);
    const responseMessage = d.type === "response_item"
      && d.payload?.type === "message"
      && ["user", "assistant"].includes(d.payload?.role)
      && Array.isArray(d.payload?.content) && d.payload.content.length > 0;
    if (eventMessage || responseMessage) {
      state.lastMessageAt = Math.max(state.lastMessageAt, t);
    }
  }

  if (d.type === "session_meta") {
    const p = d.payload ?? d;
    if (p?.id) state.sessionId = String(p.id);
    if (p?.cwd) state.cwd = String(p.cwd);
    if (p?.model) state.model = String(p.model);
    if (p?.git?.branch) state.branch = String(p.git.branch);
    state.headless ||= p?.originator === "codex_exec" || p?.source === "exec";
    if (typeof p?.title === "string") {
      const title = codexRequestTitle(p.title);
      if (title && !isProvisionalPageTitle(title)) state.title = title.slice(0, 120);
    }
    state.child = codexChildSource(p);
  }

  if (d.type === "turn_context") {
    if (d.payload?.model) state.model = String(d.payload.model);
    const effort = d.payload?.effort ?? d.payload?.reasoning_effort;
    state.effort = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort) ? effort : undefined;
    const sandbox = d.payload?.sandbox_policy?.type;
    if (sandbox === "read-only") state.accessLevel = "read-only";
    if (sandbox === "workspace-write") state.accessLevel = "workspace";
    if (sandbox === "danger-full-access") state.accessLevel = "full";
  }

  if (d.type === "event_msg" && d.payload?.type === "user_message") {
    const text = visibleUserText(d.payload.message ?? d.payload.text);
    notePrompt(state, text);
    if (!state.title) adoptRequestTitle(state, text);
  }
  if (
    (!state.title || state.prompt === undefined) &&
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
    notePrompt(state, visible);
    if (visible && !state.title) adoptRequestTitle(state, visible);
  }

  if (d.type === "event_msg" && d.payload?.type === "agent_message") {
    const raw = d.payload.message ?? d.payload.text;
    const visible = heartbeatDisplayText(raw, 'message') ?? raw;
    if (visible) state.summary = plainPreview(visible);
  }
  if (
    d.type === "response_item" &&
    d.payload?.type === "message" &&
    d.payload?.role === "assistant" &&
    Array.isArray(d.payload.content)
  ) {
    for (const block of d.payload.content) {
      if (["output_text", "text"].includes(block?.type) && typeof block.text === "string") {
        const visible = heartbeatDisplayText(block.text, 'message') ?? block.text;
        if (visible) state.summary = plainPreview(visible);
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
    state.contextUsage = codexContextReport(info, ts(d.timestamp) ?? 0) ?? state.contextUsage;
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
      session: { ...cached.session, state: codexTurnState(cached.turn ?? {}, cached.session.lastActivityAt) },
      observations: cached.observations,
      child: cached.child,
      lineage: cached.lineage,
    };
  }
  let lines: string[];
  try {
    lines = readCodexLogWindow(file);
  } catch {
    return undefined;
  }
  const state: CodexParseState = {
    sessionId: "", startedAt: 0, lastActivityAt: 0, lastMessageAt: 0,
    tokensSession: 0, tokensLastTurn: 0, workdirs: [], turn: {}, calls: createCodexLineageCalls(),
  };
  for (const line of lines) {
    if (!line) continue;
    const d = safeParse(line);
    if (d) applyCodexLine(d, state);
  }
  const head = (!state.title || (state.headless && state.prompt === undefined)) && !state.child
    ? codexHeadRequest(file, true)?.text : undefined;
  if (!state.title && !state.child) adoptRequestTitle(state, head);
  if (state.headless) notePrompt(state, head);
  if (!state.title && state.child?.agentPath) {
    state.title = childTitle(state.child.agentPath.split('/').filter(Boolean).at(-1)?.replace(/_/g, ' '));
  }
  state.title ??= state.provisionalTitle;
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
    effort: state.effort,
    summary: state.summary,
    accessLevel: state.accessLevel,
    state: codexTurnState(state.turn, state.lastActivityAt),
    startedAt: state.startedAt || state.lastActivityAt,
    lastActivityAt: state.lastActivityAt,
    ...(state.lastMessageAt ? { lastMessageAt: state.lastMessageAt } : {}),
    tokensSession: state.tokensSession,
    tokensLastTurn: state.tokensLastTurn,
    contextTokensUsed: state.contextTokensUsed,
    contextWindow: state.contextWindow,
    ...(state.contextUsage ? { contextUsage: state.contextUsage } : {}),
  };
  const observations = codexCapabilityUsage(session, lines);
  const child = state.child;
  const lineage = child ? undefined : codexLineage(state, session);
  codexSummaryCache.set(file, {
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    session,
    tokensSession: state.tokensSession,
    observations,
    child,
    turn: state.turn,
    lineage,
  });
  return { file, session, observations, child, lineage };
}

/** Where the chat came from, for `startedBy`: never published itself. A forked agent is no chat. */
function codexLineage(state: CodexParseState, session: SessionInfo): LineageFact {
  const calls = state.calls.snapshot();
  return { agent: "codex", sessionId: session.sessionId, cwd: session.cwd, startedAt: session.startedAt,
    ...(state.headless ? { headless: true } : {}), ...(state.headless && state.prompt ? { prompt: state.prompt } : {}),
    ...(calls.length ? { calls } : {}) };
}
