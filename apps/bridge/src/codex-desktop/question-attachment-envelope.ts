/** Preserve the native question envelope after document staging appends its local file note. */
export function nativeQuestionAttachmentEnvelope(text: string): string {
  const opening = '<send_user_message_question_reply>';
  const closing = '</send_user_message_question_reply>';
  const boundary = text.lastIndexOf(closing);
  if (!text.startsWith(opening) || boundary < opening.length) return text;
  const note = text.slice(boundary + closing.length);
  const header = '\n\nAttached files available locally:\n';
  if (!note.startsWith(header)) return text;
  const files = note.slice(header.length).split('\n');
  if (!files.length || files.some(line => !/^- .+: .+$/.test(line))) return text;
  try {
    const rows = JSON.parse(text.slice(opening.length, boundary));
    if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0]?.questionItemId !== 'string'
      || typeof rows[0]?.answer !== 'string') return text;
    const identity = JSON.parse(rows[0].questionItemId);
    if (!Array.isArray(identity) || identity.length !== 3 || identity[0] !== 'request_user_input_async'
      || typeof identity[1] !== 'string' || !/^[a-zA-Z0-9_-]{1,180}$/.test(identity[1])
      || !Number.isInteger(identity[2]) || identity[2] < 0 || identity[2] > 3) return text;
    rows[0].answer += note;
    return opening + '\n' + JSON.stringify(rows) + '\n' + closing;
  } catch { return text; }
}
