import { stripAttachmentNote } from '../../sessions/support/activity-helpers';

/** Public presentation boundary; never changes the original native delivery payload. */
export function questionAnswerPresentation(text: string): string {
  const opening = '<send_user_message_question_reply>';
  const closing = '</send_user_message_question_reply>';
  const wrapped = text.trim();
  if (!wrapped.startsWith(opening)) return text;
  if (!wrapped.endsWith(closing)) return 'Question reply';
  try {
    const rows = JSON.parse(wrapped.slice(opening.length, -closing.length));
    if (!Array.isArray(rows) || !rows.length || rows.length > 4) return 'Question reply';
    const answers = rows.map(row => {
      const id = JSON.parse(row.questionItemId);
      if (!Array.isArray(id) || id.length !== 3 || id[0] !== 'request_user_input_async'
        || typeof id[1] !== 'string' || !/^[a-zA-Z0-9_-]{1,180}$/.test(id[1])
        || !Number.isInteger(id[2]) || id[2] < 0 || id[2] > 3 || typeof row.answer !== 'string') throw Error('Invalid reply');
      return stripAttachmentNote(row.answer).trim();
    });
    return answers.filter(Boolean).join('; ') || 'Question reply';
  } catch { return 'Question reply'; }
}
