import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActivityEntry, SessionInfo } from '../../../../../packages/protocol/schema';
import { appendClaudeActivity } from '../../sessions/scan/claude/activity';
import { appendCodexActivity } from '../../sessions/scan/codex/activity/rows';
import { presentableTitle, visibleUserText } from '../../sessions/support/activity-helpers';
import { queueNote, stripQueueNote, withQueueNote } from '../queue-note';

const typed = 'Fix the flaky login test, then tell me what broke';

test('the line counts the messages behind this one, in the singular and the plural', () => {
  assert.equal(queueNote(1), 'GrantTap: 1 more message from the phone is queued for this chat and arrives after this turn. '
    + 'Tests of what you change can run now; repository-wide checks, full test runs and publishing can wait for it '
    + 'unless this message asks for those now.');
  assert.equal(queueNote(3), 'GrantTap: 3 more messages from the phone are queued for this chat and arrive after this turn. '
    + 'Tests of what you change can run now; repository-wide checks, full test runs and publishing can wait for the last '
    + 'of them unless this message asks for those now.');
  for (const none of [undefined, 0, -2, 1.5, Number.NaN]) assert.equal(queueNote(none), undefined, String(none));
});

test('the person\'s text stays intact and comes first; an empty queue adds nothing', () => {
  assert.equal(withQueueNote(typed, 2), `${typed}\n\n${queueNote(2)}`);
  assert.equal(withQueueNote(typed, 0), typed);
  assert.equal(withQueueNote(typed, undefined), typed);
  assert.equal(withQueueNote('', 2), '', 'a message of attachments alone keeps its empty text for the attachment step');
  assert.equal(stripQueueNote(withQueueNote(typed, 2)), typed);
});

test('the phone\'s transcript view shows the person\'s words without the line', () => {
  const attachments = '\n\nAttached files available locally (inspect them as part of this request):\n- log.txt: /tmp/x/1-log.txt';
  for (const count of [1, 4]) {
    const prompt = withQueueNote(typed, count);
    assert.equal(visibleUserText(prompt), typed);
    assert.equal(visibleUserText(`${prompt}${attachments}`), typed, 'with the attachment note after it');
    assert.equal(visibleUserText(`<user_query>\n${prompt}\n</user_query>`), typed, 'inside a host wrapper');
    assert.equal(presentableTitle(prompt), typed, 'and as the chat name');
  }
  const session: SessionInfo = { sessionId: 'queue-note-chat', agent: 'claude', state: 'idle', startedAt: 1,
    lastActivityAt: 2, tokensSession: 0, tokensLastTurn: 0 };
  const prompt = withQueueNote(typed, 2);
  const claude: ActivityEntry[] = [];
  appendClaudeActivity({ out: claude, seen: new Set(), session, observations: new Map(), lines: [
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-11-16T10:00:00Z', message: { role: 'user', content: prompt } }),
    JSON.stringify({ type: 'user', uuid: 'u2', timestamp: '2026-11-16T10:01:00Z',
      message: { role: 'user', content: [{ type: 'text', text: `${prompt}${attachments}` }] } }),
  ] });
  assert.deepEqual(claude.map(entry => [entry.kind, entry.text]), [['user', typed], ['user', typed]]);
  const codex: ActivityEntry[] = [];
  appendCodexActivity({ out: codex, seen: new Set(), session: { ...session, agent: 'codex' }, observations: new Map(), lines: [
    JSON.stringify({ type: 'event_msg', timestamp: '2026-11-16T10:00:00Z', payload: { type: 'user_message', message: prompt } }),
  ] });
  assert.deepEqual(codex.map(entry => [entry.kind, entry.text]), [['user', typed]]);
});

test('words that merely resemble the line stay, and so does a line in the middle of the person\'s text', () => {
  const quoted = 'GrantTap: 3 more messages from the phone are queued for this chat — is that wording right?';
  assert.equal(visibleUserText(quoted), quoted);
  const middle = `${withQueueNote('first part', 2)} and then the person kept typing`;
  assert.equal(stripQueueNote(middle), middle);
});
