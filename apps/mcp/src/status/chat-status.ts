import { limitContinuationFor } from "../../../bridge/src/limit-continuation";
import { queuedPhoneMessages } from "../../../bridge/src/task-dispatch/worker/queue-depth";
import { sessionFromEnvironment } from "../mcp-tools/mesh/session-env";

export type ChatStatus = {
  queuedPhoneMessages: number;
  autoContinue: boolean;
  continuation: { dueAt: number; early: boolean } | null;
};

/**
 * What this computer holds for the chat that started this MCP server: the phone messages queued to
 * reach it after its current turn, and whether it goes on by itself after a subscription limit. The
 * chat is the one Claude Code names in this server's environment; other hosts name none, and no
 * chat is guessed from a working directory. Reading writes nothing.
 */
export function chatStatus(room: string | undefined, env: NodeJS.ProcessEnv = process.env): ChatStatus | null {
  const sessionId = sessionFromEnvironment(env);
  if (!sessionId || !room) return null;
  let queued = 0;
  try { queued = queuedPhoneMessages(sessionId, room); } catch { /* An unreadable queue shows none. */ }
  const limit = limitContinuationFor(sessionId);
  return { queuedPhoneMessages: queued, autoContinue: limit.autoContinue, continuation: limit.continuation ?? null };
}

export function chatStatusLine(chat: ChatStatus | null): string | undefined {
  if (!chat) return undefined;
  const queued = chat.queuedPhoneMessages === 0 ? "no phone messages are queued for it"
    : `${chat.queuedPhoneMessages} phone message${chat.queuedPhoneMessages === 1 ? " is" : "s are"} queued to reach it after this turn`;
  const limit = chat.continuation
    ? `a continuation after a subscription limit is queued for it, due ${new Date(chat.continuation.dueAt).toISOString()}`
      + (chat.continuation.early ? ", and another to go at once because the account's readings showed room" : "")
    : chat.autoContinue ? "it continues by itself if a subscription limit stops it"
      : "it does not continue by itself after a subscription limit (turned off on the phone)";
  return `This chat: ${queued}; ${limit}.`;
}
