import { limitContinuationFor } from "../../../bridge/src/limit-continuation";
import { consumeAttributedCall } from "../../../bridge/src/mesh/identity/call-scope";
import { queuedPhoneMessages } from "../../../bridge/src/task-dispatch/worker/queue-depth";
import { chatBinding, type ChatHost } from "../chat-identity";

export type CallingChat = { sessionId: string; provider?: ChatHost; identifiedBy: "environment" | "transcript" | "hook" };

export type ChatStatus = {
  sessionId: string;
  provider: ChatHost | null;
  identifiedBy: CallingChat["identifiedBy"];
  queuedPhoneMessages: number;
  autoContinue: boolean;
  continuation: { dueAt: number; early: boolean } | null;
};

/**
 * The chat that made this call. The server's own chat comes first (`chat-identity`: Claude Code's and Grok
 * Build's environment, a Codex CLI chat's open rollout). A server shared by several chats, as Cursor starts,
 * knows none; the provider hook that ran inside the calling chat recorded this exact call, and that record names
 * it. Nothing the model passes names a chat, and no chat is guessed from a working directory.
 */
export function callingChat(tool: string, args: unknown, now = Date.now()): CallingChat | undefined {
  const own = chatBinding();
  let attributed: ReturnType<typeof consumeAttributedCall>;
  try { attributed = consumeAttributedCall(tool, args ?? {}, now, own.sessionId); } catch { attributed = undefined; }
  if (own.sessionId) {
    return { sessionId: own.sessionId, provider: own.provider, identifiedBy: own.source ?? "environment" };
  }
  return attributed ? { sessionId: attributed.sessionId, provider: attributed.provider, identifiedBy: "hook" } : undefined;
}

/** The chat this server was started for, without a call to attribute. */
export function serverChat(): CallingChat | undefined {
  const own = chatBinding();
  return own.sessionId ? { sessionId: own.sessionId, provider: own.provider, identifiedBy: own.source ?? "environment" }
    : undefined;
}

/**
 * What this computer holds for the calling chat: the phone messages queued to reach it after its current turn,
 * and whether it goes on by itself after a subscription limit. Reading writes nothing.
 */
export function chatStatus(room: string | undefined, chat: CallingChat | undefined = serverChat()): ChatStatus | null {
  if (!chat || !room) return null;
  let queued = 0;
  try { queued = queuedPhoneMessages(chat.sessionId, room); } catch { /* An unreadable queue shows none. */ }
  const limit = limitContinuationFor(chat.sessionId);
  return { sessionId: chat.sessionId, provider: chat.provider ?? null, identifiedBy: chat.identifiedBy,
    queuedPhoneMessages: queued, autoContinue: limit.autoContinue, continuation: limit.continuation ?? null };
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
