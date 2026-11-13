import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseClaudeFile, parseClaudeFileSteps } from '../parse';
import { claudeSummaryCache } from '../shared';

const SESSION = 'c0000000-0000-4000-8000-000000000001';
const row = (index: number, extra: object = {}) => JSON.stringify({ type: 'user', sessionId: SESSION, cwd: '/fixture',
  timestamp: new Date(Date.now() - 1_000 + index).toISOString(), message: { role: 'user', content: `Synthetic ${index}` }, ...extra });
const spent = (index: number) => JSON.stringify({ type: 'assistant', sessionId: SESSION, timestamp: new Date(Date.now() - 1_000 + index).toISOString(),
  message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `Answer ${index}` }], usage: { input_tokens: 10, output_tokens: 5 } } });

function fixture(t: { after: (run: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-incremental-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, `${SESSION}.jsonl`);
}

test('appended rows add up to the same summary as reading the whole transcript', t => {
  const file = fixture(t);
  writeFileSync(file, `${row(1)}\n${spent(2)}\n`);
  assert.equal(parseClaudeFile(file)?.session.tokensSession, 15);
  appendFileSync(file, `${row(3)}\n${spent(4)}\n`);
  const grown = parseClaudeFile(file);
  claudeSummaryCache.delete(file);
  const whole = parseClaudeFile(file);
  assert.equal(grown?.session.tokensSession, 30, 'earlier rows are not counted twice');
  assert.deepEqual({ ...grown?.session, state: 'idle' }, { ...whole?.session, state: 'idle' });
});

test('a row still being written waits, and is counted once when it completes', t => {
  const file = fixture(t);
  const partial = spent(2);
  writeFileSync(file, `${row(1)}\n${partial.slice(0, 20)}`);
  assert.equal(parseClaudeFile(file)?.session.tokensSession, 0);
  appendFileSync(file, `${partial.slice(20)}\n`);
  assert.equal(parseClaudeFile(file)?.session.tokensSession, 15);
});

test('a complete last row without a newline is counted once', t => {
  const file = fixture(t);
  writeFileSync(file, `${row(1)}\n${spent(2)}`);
  assert.equal(parseClaudeFile(file)?.session.tokensSession, 15);
  appendFileSync(file, `\n${spent(3)}\n`);
  assert.equal(parseClaudeFile(file)?.session.tokensSession, 30);
});

test('a transcript rewritten in place or replaced is read again from the start', t => {
  const file = fixture(t);
  writeFileSync(file, `${row(1)}\n${spent(2)}\n`);
  parseClaudeFile(file);
  writeFileSync(file, `${row(1, { cwd: '/rewritten' })}\n${spent(2)}\n${spent(3)}\n`);
  const rewritten = parseClaudeFile(file);
  assert.equal(rewritten?.session.tokensSession, 30);
  assert.equal(rewritten?.session.cwd, '/rewritten');
  const replacement = `${file}.next`;
  writeFileSync(replacement, `${row(1)}\n${spent(2)}\n${spent(3)}\n${spent(4)}\n`);
  renameSync(replacement, file);
  assert.equal(parseClaudeFile(file)?.session.tokensSession, 45);
  writeFileSync(file, `${row(1)}\n`);
  assert.equal(parseClaudeFile(file)?.session.tokensSession, 0, 'a shorter transcript is not continued');
});

test('a large transcript yields between slices, and a parallel reader cannot double count', t => {
  const file = fixture(t);
  const padding = 'x'.repeat(700_000);
  writeFileSync(file, [row(1), ...Array.from({ length: 6 }, (_, index) => row(index + 2, { padding })), spent(9)].join('\n') + '\n');
  const steps = parseClaudeFileSteps(file);
  let yields = 0;
  let step = steps.next();
  assert.equal(parseClaudeFile(file)?.session.tokensSession, 15, 'a reader during a pass gets a complete answer');
  while (!step.done) { yields += 1; step = steps.next(); }
  assert.ok(yields >= 3, `yielded ${yields} times`);
  assert.equal(step.value?.session.tokensSession, 15);
  assert.equal(parseClaudeFile(file)?.session.tokensSession, 15);
});

const modelAt = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const answer = (offsetMs: number, model: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  sessionId: "claude-model", type: "assistant", timestamp: modelAt(offsetMs), ...extra,
  message: { role: "assistant", model, stop_reason: "end_turn", content: [{ type: "text", text: "Synthetic answer" }],
    usage: { input_tokens: 10, output_tokens: 5 } } });
const asked = (offsetMs: number) => JSON.stringify({ sessionId: "claude-model", type: "user", timestamp: modelAt(offsetMs),
  message: { role: "user", content: "Synthetic question" } });

test("a chat's model is the one its own latest answer used, not the first, a subagent's or an error placeholder", () => {
  const directory = mkdtempSync(join(tmpdir(), "granttap-claude-model-"));
  const file = join(directory, "claude-model.jsonl");
  try {
    writeFileSync(file, [asked(-60_000), answer(-59_000, "claude-opus-5-5")].join("\n") + "\n");
    assert.equal(parseClaudeFile(file)?.session.model, "claude-opus-5-5");
    appendFileSync(file, [asked(-40_000), answer(-39_000, "claude-fable-5-2")].join("\n") + "\n");
    assert.equal(parseClaudeFile(file)?.session.model, "claude-fable-5-2", "the phone's header follows a model change");
    appendFileSync(file, [
      answer(-30_000, "claude-haiku-5-5", { isSidechain: true }),
      answer(-20_000, "<synthetic>", { isApiErrorMessage: true }),
    ].join("\n") + "\n");
    assert.equal(parseClaudeFile(file)?.session.model, "claude-fable-5-2",
      "a subagent's model and the placeholder of an error message are not the chat's model");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
