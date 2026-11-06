import { visibleUserText } from './activity-helpers';
import { childTitle } from './child-threads';

/** A host answer envelope, including a previously clipped native title, is not a Task name. */
export function isCodexQuestionReply(text: string): boolean {
  const value = text.trimStart();
  return value.startsWith('<send_user_message_question_reply>')
    || /^\[\s*\{\s*"questionItemId"\s*:/.test(value);
}

/** Keep transport payloads intact in history; only title selection rejects them. */
export function codexRequestTitle(value: unknown): string | undefined {
  const text = visibleUserText(value);
  return isCodexQuestionReply(text) ? undefined : childTitle(text);
}
