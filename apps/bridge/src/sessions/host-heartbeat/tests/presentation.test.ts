import assert from 'node:assert/strict';
import test from 'node:test';
import { pushEntry, visibleUserText } from '../../support/activity-helpers';
import type { ActivityEntry } from '../../../../../../packages/protocol/schema';

const request = '<heartbeat><automation_id>fixture</automation_id><current_time_iso>2026-10-25T16:00:00Z</current_time_iso>'
  + '<instructions>Continue checks.</instructions></heartbeat>';
const response = (decision = 'NOTIFY', message = 'Checks **passed** &amp; saved.') =>
  `<heartbeat><automation_id>fixture</automation_id><decision>${decision}</decision><message>${message}</message></heartbeat>`;

function projected(text: string, kind: ActivityEntry['kind'] = 'final') {
  const out: ActivityEntry[] = [];
  pushEntry({ out, seen: new Set(), sessionId: 'fixture', kind, text, createdAt: 1, ordinal: 0,
    idOverride: 'native-stable-id' });
  return out;
}

test('heartbeat instructions and quiet responses do not become conversation messages or titles', () => {
  assert.equal(visibleUserText(request), '');
  assert.deepEqual(projected(request, 'user'), []);
  assert.deepEqual(projected(response('DONT_NOTIFY')), []);
});

test('notifying heartbeat retains native identity and renders decoded text before clipping', () => {
  const rows = projected(response());
  assert.equal(rows[0]?.text, 'Checks **passed** & saved.');
  assert.equal(rows[0]?.id, 'native-stable-id');
  assert.equal(rows[0]?.kind, 'final');
  const raw = response('NOTIFY', 'A'.repeat(18_000));
  assert.equal(projected(raw)[0]?.text.startsWith('<'), false);
  assert.equal(projected(raw)[0]?.text.length, 16_384);
});

test('quoted, malformed, unfamiliar, and wrong-role envelopes remain readable as received', () => {
  const raw = response();
  const examples = ['```xml\n' + raw + '\n```', 'Explain this:\n' + raw, raw + '\nMore',
    raw.slice(0, -12), response('UNKNOWN'), response('NOTIFY', ''), response('NOTIFY', '<b>Example</b>'),
    response('NOTIFY', '&unknown;'), response('NOTIFY', '&#x110000;'), response('NOTIFY', '&#xD800;'),
    response('NOTIFY', '& bare'), raw.replace('fixture', ' '), raw.replace('<message>', '<message format="x">'),
    raw.replace('</heartbeat>', '<extra>value</extra></heartbeat>'),
    raw.replace('<decision>', '<decision>NOTIFY</decision><decision>'),
    raw.replace('<heartbeat>', '<heartbeat source="example">'),
    '<!DOCTYPE heartbeat [<!ENTITY x SYSTEM "file:///invalid">]>' + raw];
  for (const text of examples) assert.equal(projected(text)[0]?.text, text);
  for (const kind of ['user', 'tool', 'status'] as const) assert.equal(projected(raw, kind)[0]?.text, raw);
  assert.equal(projected(request, 'final')[0]?.text, request);
});

test('XML escapes and whitespace decode without losing Markdown or literal code', () => {
  assert.equal(projected(' \n' + response('NOTIFY', 'Use &lt;heartbeat&gt; &quot;x&quot; &apos;y&apos; &#65; &#x1F600;.\n\n`code`') + '\n ')[0]?.text,
    'Use <heartbeat> "x" \'y\' A 😀.\n\n`code`');
  assert.equal(visibleUserText(request.replace('<instructions>Continue checks.</instructions>', '<instructions> </instructions>')),
    request.replace('<instructions>Continue checks.</instructions>', '<instructions> </instructions>'));
});
