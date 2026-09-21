import assert from "node:assert/strict";
import test from "node:test";
import type { SessionInfo } from "../../../packages/protocol/schema";
import { deduplicateNativeSessions } from "../../../apps/bridge/src/mesh/runtime/capabilities/session-discovery";

function session(agent: string, tokens: number): SessionInfo {
  return {
    sessionId: "same-id", agent, state: "idle", startedAt: 1, lastActivityAt: tokens,
    tokensSession: tokens, tokensLastTurn: 0,
  };
}

test("different providers retain same native ID and current report wins over history", () => {
  const sessions = deduplicateNativeSessions(
    [session("codex", 2), session("claude", 3)],
    [session("codex", 5)],
  );
  assert.equal(sessions.length, 2);
  assert.equal(sessions.find((item) => item.agent === "codex")?.tokensSession, 5);
  assert.equal(sessions.find((item) => item.agent === "claude")?.tokensSession, 3);
});
