import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { describeRun, runJournal } from '../../admin/journal';
import { noteDeliveredRun } from '../run-digest';
import type { SessionInfo } from '../../../../../../packages/protocol/schema';

test('question reply progress and durable journal show the answer without native protocol fields', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-question-progress-'));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true }); });
  const session = { sessionId: 'synthetic-question-progress', agent: 'codex' } as SessionInfo;
  const prompt = '<send_user_message_question_reply>\n' + JSON.stringify([{
    questionItemId: JSON.stringify(['request_user_input_async', 'call_synthetic', 0]),
    question: 'Synthetic delay?', answer: 'Около 10–30 секунд',
  }]) + '\n</send_user_message_question_reply>';
  const result = noteDeliveredRun({ session, prompt, startedAt: 1, endedAt: 2,
    result: { ok: false, error: 'Synthetic delivery failure' },
    deps: { activity: () => ({ entries: [] }), writes: () => [], scope: () => undefined,
      store: () => { throw Error('No mesh'); }, meshEnabled: () => false, now: () => 2, eventId: () => 'synthetic' } });
  assert.ok(result);
  assert.equal(describeRun(result.record), '«Около 10–30 секунд» → failed: Synthetic delivery failure');
  assert.equal(runJournal(session.sessionId)[0]?.prompt, 'Около 10–30 секунд');
  assert.equal(prompt.includes('questionItemId'), true, 'Wire payload is not mutated');
});
