import { randomUUID } from "node:crypto";
import type { ActivityEntry, SessionInfo } from "../../../../../../packages/protocol/schema";
import { childTitle } from "../../support/child-threads";
import { appendConversationEntry, conversationSessions, readConversation, sameConversationWorkspace,
  writeConversation, type ConversationRecord } from "./storage";
import { CursorConversationTools } from './tools';
export { cursorConversationHistory } from "./history";

/** A Task's visible turns remain readable independently of Cursor's private ACP database. */
export function beginCursorTurn(input: { sessionId: string; cwd: string; text: string;
  session?: SessionInfo; model?: string }) {
  const previous = readConversation(input.sessionId);
  if (previous && !sameConversationWorkspace(previous, input.cwd)) throw new Error("Cursor history belongs to another workspace");
  const now = Date.now(), turn = randomUUID(), base = input.session ?? previous?.session;
  const record: ConversationRecord = { version: 1, turn, owner: process.pid, session: {
    sessionId: input.sessionId, agent: "cursor", cwd: input.cwd,
    title: base?.title ?? childTitle(input.text)?.slice(0, 120), model: input.model ?? base?.model,
    state: "working", startedAt: base?.startedAt ?? now, lastActivityAt: now, lastMessageAt: now,
    tokensSession: base?.tokensSession ?? 0, tokensLastTurn: base?.tokensLastTurn ?? 0,
    projectId: base?.projectId, taskId: base?.taskId, computerId: base?.computerId,
  } };
  writeConversation(record);
  appendConversationEntry(input.sessionId, { id: `cursor-turn:${turn}:user`, kind: "user",
    text: input.text.slice(0, 64_000), createdAt: now });
  let response = "", timer: NodeJS.Timeout | undefined, finished = false, segment = 0;
  const change = (apply: (current: ConversationRecord) => void) => {
    const current = readConversation(input.sessionId);
    if (!current || current.turn !== turn) return;
    apply(current); current.session.lastActivityAt = Date.now(); writeConversation(current);
  };
  const flush = () => {
    if (timer) clearTimeout(timer); timer = undefined;
    if (!response.trim() || finished) return;
    change(current => { current.live = { id: `cursor-turn:${turn}:assistant${segment ? ':' + segment : ''}`, kind: "message",
      text: response, createdAt: current.live?.createdAt ?? Date.now() }; });
  };
  const tools = new CursorConversationTools(`${input.sessionId}:cursor-turn:${turn}`, entry => {
    change(() => appendConversationEntry(input.sessionId, entry));
  });
  return {
    state(state: "working" | "waiting") { if (!finished) change(current => { current.session.state = state; }); },
    update(text: string) {
      if (finished) return; response = text.slice(-64_000);
      if (!timer) { timer = setTimeout(() => {
        try { flush(); } catch { /* The final flush retries without crashing the machine runtime. */ }
      }, 400); timer.unref(); }
    },
    tool(raw: unknown) {
      if (finished) return;
      if (raw && typeof raw === 'object' && (raw as { sessionUpdate?: unknown }).sessionUpdate === 'tool_call') {
        flush();
        change(current => {
          if (current.live) appendConversationEntry(input.sessionId, current.live);
          delete current.live;
        });
        response = ''; segment++;
      }
      tools.update(raw);
    },
    finish(error?: string) {
      if (finished) return;
      flush(); finished = true;
      change(current => {
        if (current.live) appendConversationEntry(input.sessionId, { ...current.live, kind: error ? 'message' : 'final' });
        if (error) appendConversationEntry(input.sessionId, { id: `cursor-turn:${turn}:status`, kind: "status",
          text: error.slice(0, 4_000), createdAt: Date.now() });
        delete current.live; current.session.state = "idle";
      });
    },
  };
}

export function cursorConversationSession(sessionId: string): SessionInfo | undefined {
  try {
    const record = readConversation(sessionId); if (!record) return;
    if (record.session.state !== "idle") {
      try { process.kill(record.owner, 0); } catch { record.session.state = "idle"; }
    }
    return record.session;
  } catch { return undefined; }
}

export function mergeCursorConversations(sessions: SessionInfo[]): SessionInfo[] {
  const byId = new Map(sessions.map(session => [session.sessionId, session]));
  for (const saved of conversationSessions()) {
    const current = cursorConversationSession(saved.sessionId)!;
    const native = byId.get(saved.sessionId);
    if (!native) byId.set(saved.sessionId, current);
    else if (current.lastActivityAt >= native.lastActivityAt) byId.set(saved.sessionId, {
      ...native, ...current, title: native.title ?? current.title,
      tokensSession: native.tokensSession, tokensLastTurn: native.tokensLastTurn,
      childThreads: native.childThreads, contextTokensUsed: native.contextTokensUsed,
    });
  }
  return [...byId.values()];
}
