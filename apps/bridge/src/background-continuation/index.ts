/**
 * A Claude chat whose background work Claude Code stopped after its turn gets a "continue" from this
 * computer, through the relay's queue like a phone message. See README.md.
 */
import { createHash, randomBytes } from 'node:crypto';
import { UserMessage, type SessionInfo } from '../../../../packages/protocol/schema';
import { isSessionPaused } from '../config';
import { limitContinuationFor } from '../limit-continuation';
import type { NativeQueueScope } from '../task-dispatch/sender/store';
import { type StoppedWork } from './detect';
import { continuedSince, noteContinued } from './store';

export { noteProviderRunEnded, registerStoppedWorkHandler, stoppedBackgroundWork, type StoppedWork } from './detect';

/** A chat is continued this often in `CONTINUE_WINDOW_MS` at most: work that keeps being stopped waits for the person. */
export const CONTINUE_LIMIT = 3;
export const CONTINUE_WINDOW_MS = 6 * 3_600_000;
const PREFIX = 'background-continue-';

/** What the agent reads. It says why the work stopped, so the next turn keeps long work inside itself. */
export function backgroundContinuePrompt(after: string): string {
  return `GrantTap: Claude Code stopped this chat's background work ${after} after your last turn ended, before it `
    + 'finished. Check what it left and finish the work. In a chat GrantTap runs, background agents and commands '
    + `stop ${after} after a turn ends, and ten minutes after it once a new message waits for the chat, so keep `
    + 'long work inside the turn: run agents in the foreground (several started in one message still run in '
    + 'parallel) and wait for long commands before you end the turn.';
}

export function isBackgroundContinuation(message: Pick<UserMessage, 'messageId'>): boolean {
  return !!message.messageId?.startsWith(PREFIX);
}

/** Puts one message on the relay's durable queue, as `NativeTaskQueueSender.submit` does. */
export type ContinuationSubmit = (scope: NativeQueueScope, message: UserMessage, notBefore: number, createdAt: number)
  => Promise<unknown>;

/** What the monitor knows about the chat when its run ends. */
export type StoppedChat = {
  sessionId: string;
  /** The chat as the monitor last published it; undefined when it is not listed. */
  session?: SessionInfo;
  /** Phone messages waiting for the chat: the first of them resumes it, and Claude tells it what stopped. */
  phoneMessagesWaiting: number;
};

/** Why the chat is not continued, in words for the monitor log; undefined when it is. */
function refusal(chat: StoppedChat, now: number): string | undefined {
  const { session, sessionId } = chat;
  if (!session) return 'the chat is not in this computer\'s catalog';
  if (session.agent !== 'claude') return `${session.agent} chats are not continued`;
  if (chat.phoneMessagesWaiting > 0) return 'a message from the phone waits for it and resumes it';
  if (isSessionPaused(sessionId)) return 'the chat is paused';
  if (!limitContinuationFor(sessionId).autoContinue) return 'continuing by itself is turned off for it on the phone';
  if (continuedSince(sessionId, now - CONTINUE_WINDOW_MS) >= CONTINUE_LIMIT) {
    return `it was continued ${CONTINUE_LIMIT} times in the last ${CONTINUE_WINDOW_MS / 3_600_000} hours`;
  }
  return undefined;
}

function log(sessionId: string, stopped: StoppedWork, event: string): void {
  process.stderr.write(`[monitor] Claude Code stopped the background work of chat ${sessionId.slice(0, 8)} `
    + `${stopped.after} after its turn: ${event}.\n`);
}

/**
 * Queues a "continue" for a chat whose background work Claude stopped, due at once. It is recorded
 * before it is queued, so a relay that keeps failing cannot make it repeat past the limit; the sender
 * keeps a copy it could not upload and sends it again.
 */
export async function continueStoppedWork(submit: ContinuationSubmit, chat: StoppedChat, stopped: StoppedWork,
  now = Date.now()): Promise<boolean> {
  let why: string | undefined;
  try { why = refusal(chat, now); } catch (error) { why = `its settings could not be read (${String(error).slice(0, 80)})`; }
  if (why) { log(chat.sessionId, stopped, `not continued: ${why}`); return false; }
  const session = chat.session!, cwd = session.worktree ?? session.cwd;
  const messageId = PREFIX + createHash('sha256').update(`${chat.sessionId}:${now}:${randomBytes(8).toString('hex')}`)
    .digest('hex').slice(0, 40);
  const message = UserMessage.parse({ type: 'user.message', messageId, sessionId: chat.sessionId, agent: 'claude',
    text: backgroundContinuePrompt(stopped.after), createdAt: now, ...(cwd ? { cwd } : {}),
    ...(session.projectId ? { projectId: session.projectId } : {}) });
  const scope: NativeQueueScope = { sessionId: chat.sessionId, provider: 'claude',
    ...(session.projectId ? { projectId: session.projectId } : {}), ...(session.taskId ? { taskId: session.taskId } : {}) };
  try {
    noteContinued(chat.sessionId, now, now - CONTINUE_WINDOW_MS);
    await submit(scope, message, now, now);
  } catch (error) {
    log(chat.sessionId, stopped, `the continuation could not be queued (${String(error).slice(0, 120)})`);
    return false;
  }
  log(chat.sessionId, stopped, 'a continuation is queued');
  return true;
}
