const ADVICE = 'Tests of what you change can run now; repository-wide checks, full test runs and publishing can wait for';
const ASKED = 'unless this message asks for those now.';

/**
 * The line a phone message carries into its chat when more messages for that chat wait behind it.
 * The agent can then leave repository-wide checks, full test runs and publishing for the last of
 * them instead of running them once per message. It is GrantTap's line, not the person's: the
 * transcript views remove it (`stripQueueNote`), so the phone shows the words the person typed.
 */
export function queueNote(count: number | undefined): string | undefined {
  if (!count || !Number.isSafeInteger(count) || count < 1) return undefined;
  return count === 1
    ? `GrantTap: 1 more message from the phone is queued for this chat and arrives after this turn. ${ADVICE} it ${ASKED}`
    : `GrantTap: ${count} more messages from the phone are queued for this chat and arrive after this turn. `
      + `${ADVICE} the last of them ${ASKED}`;
}

/**
 * The person's text with the line after it, as its own paragraph. A message of attachments alone
 * gets no line: its prompt is written by the attachment step, which needs the text left empty.
 */
export function withQueueNote(text: string, count: number | undefined): string {
  const note = queueNote(count);
  return note && text.trim() ? `${text}\n\n${note}` : text;
}

const NOTE = new RegExp('\\n\\nGrantTap: \\d+ more messages? from the phone (?:is|are) queued for this chat and arrives? '
  + `after this turn\\. ${ADVICE} (?:it|the last of them) ${ASKED.replace('.', '\\.')}(?=\\n\\n|$)`);

/** The text without that line, wherever the attachment note or a host wrapper left it. */
export function stripQueueNote(text: string): string {
  return text.replace(NOTE, '');
}
