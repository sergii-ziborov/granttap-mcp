import type { SessionControl } from "../../../../packages/protocol/schema";
import { setSessionPaused } from "../config";
import { compactCodexSession } from "../providers/codex-control";
import { deliverToSession, stopDeliveries } from "../reply";
import { scanSessionHistory, scanSessions } from "../sessions";

const DELIVERY_TIMEOUT_MS = 240_000;

/** What the agent is told when the person lifts the hold and asks it to go on. */
export const RESUME_PROMPT =
  "GrantTap: this chat was resumed in GrantTap. Continue the work you were doing before the pause; tool calls are allowed again.";

/**
 * Pause or resume one chat.
 *
 * A pause is a hold on tool calls, enforced by the provider hooks on every call
 * the chat makes, plus a stop of any delivery already running for it. The
 * result goes back at once; the continuation a resume asks for runs in the
 * background, so a phone that tapped "resume" does not wait on a whole turn.
 */
export async function controlTaskSession(
  message: SessionControl,
  reply: (ok: boolean, text: string) => Promise<void>,
  afterContinue: () => void = () => {},
): Promise<void> {
  const sessionId = message.sessionId;
  try {
    setSessionPaused(sessionId, message.action === "pause");
  } catch (error) {
    return reply(false, error instanceof Error ? error.message : String(error));
  }
  if (message.action === "pause") {
    const stopped = stopDeliveries(sessionId);
    return reply(true, stopped > 0
      ? `Paused. Stop requested for ${stopped} running turn${stopped === 1 ? "" : "s"}; process exit is not yet confirmed. Every new tool call from this chat is refused until you resume.`
      : "Paused: every tool call from this chat is refused until you resume.");
  }
  if (!message.continue) return reply(true, "Resumed: tool calls are allowed again.");
  const session = scanSessions().sessions.find((item) => item.sessionId === sessionId)
    ?? scanSessionHistory().find((item) => item.sessionId === sessionId);
  if (!session) {
    return reply(true, "Resumed. This chat is not on this computer any more, so nothing was asked to continue.");
  }
  await reply(true, "Resumed and asked to continue.");
  void deliverToSession(session, RESUME_PROMPT, DELIVERY_TIMEOUT_MS, [], { ignorePause: true })
    .then((result) => {
      if (!result.ok) {
        process.stderr.write(`[monitor] resume of ${sessionId.slice(0, 8)} did not continue: ${result.error}\n`);
      }
    })
    .catch(() => {})
    .finally(afterContinue);
}

export async function compactTaskSession(sessionId: string,
  resultMessage: (ok: boolean, text: string) => Promise<void>): Promise<void> {
  const session = scanSessions().sessions.find((item) => item.sessionId === sessionId);
  if (!session) return resultMessage(false, "This task is no longer available on the computer.");
  if (session.agent !== "codex") {
    return resultMessage(false, "Claude Code does not expose a supported remote compaction API.");
  }
  if (session.state === "working") {
    return resultMessage(false, "Wait for the active Codex turn to finish before compacting it.");
  }

  const result = await compactCodexSession(session.sessionId);
  await resultMessage(
    result.ok,
    result.ok ? "Codex context compaction completed." : `Context compaction failed: ${result.error}`,
  );
}

