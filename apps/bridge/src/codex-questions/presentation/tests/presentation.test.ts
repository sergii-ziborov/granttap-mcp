import assert from 'node:assert/strict';
import test from 'node:test';
import { questionAnswerPresentation } from '..';

const wrap = (rows: unknown) => '<send_user_message_question_reply>\n' + JSON.stringify(rows)
  + '\n</send_user_message_question_reply>';
const reply = { questionItemId: '["request_user_input_async","call_synthetic",0]',
  answer: 'Synthetic answer', question: 'Synthetic question?' };

test('progress presents multiple human answers and omits staged document notes', () => {
  assert.equal(questionAnswerPresentation(wrap([reply, { ...reply,
    answer: 'Second answer\n\nAttached files available locally:\n- proof.txt: /tmp/proof.txt' }])),
  'Synthetic answer; Second answer');
  assert.equal(questionAnswerPresentation('Ordinary message'), 'Ordinary message');
  const example = 'Example: ' + wrap([reply]);
  assert.equal(questionAnswerPresentation(example), example);
});

test('malformed and previously truncated envelopes do not leak protocol fields into progress', () => {
  const malformed = ['<send_user_message_question_reply>[{"questionItemId":', wrap([]), wrap({}),
    wrap([{ ...reply, questionItemId: 'bad' }]), wrap([{ ...reply, questionItemId: '["other","call",0]' }]),
    wrap([{ ...reply, questionItemId: '["request_user_input_async","call",9]' }]),
    wrap([{ ...reply, answer: 3 }]), wrap([{ ...reply, answer: '' }]), wrap(Array(5).fill(reply))];
  for (const value of malformed) assert.equal(questionAnswerPresentation(value), 'Question reply');
});
