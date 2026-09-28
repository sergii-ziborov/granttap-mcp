import type { SessionInfo } from "../../../../../packages/protocol/schema";

/** Native usage facts only; prompts, paths and conversation text stay out. */
export function desktopUsageSessions(sessions: readonly SessionInfo[]) {
  const rows = new Map<string, SessionInfo>();
  for (const session of sessions) {
    const key = `${session.agent}\u0000${session.sessionId}`;
    const previous = rows.get(key);
    if (!previous || session.lastActivityAt > previous.lastActivityAt) rows.set(key, session);
  }
  return [...rows.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, 512).map(session => ({
      sessionId: session.sessionId, agent: session.agent,
      tokensSession: session.tokensSession, tokensLastTurn: session.tokensLastTurn,
      model: session.model, contextTokensUsed: session.contextTokensUsed,
      contextWindow: session.contextWindow,
    }));
}
