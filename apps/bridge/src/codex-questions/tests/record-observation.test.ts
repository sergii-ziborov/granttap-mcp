import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { questionId } from '../observations';
import { readQuestion, saveQuestion, type QuestionRecord } from '../records';

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(join(tmpdir(), 'granttap-question-observation-'));
  const previous = process.env.GRANTTAP_CONFIG_DIR; process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const record: QuestionRecord = { requestId: questionId('fixture-session', 'fixture-call', 0),
    sessionId: 'fixture-session', callId: 'fixture-call', index: 0, question: 'Fixture question',
    options: ['Fixture choice'], createdAt: 1, room: 'fixture-room' };
  return { record, file: join(root, 'codex-question-records', record.requestId + '.json') };
}

test('repeated observations read unchanged durable question bytes once and callers cannot mutate that observation', t => {
  const { record, file } = fixture(t); saveQuestion(record);
  const read = fs.readFileSync; let reads = 0;
  t.mock.method(fs, 'readFileSync', (path: fs.PathOrFileDescriptor, options: any) => {
    if (path === file) reads++; return read(path, options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (let index = 0; index < 20; index++) assert.deepEqual(readQuestion(record.requestId), record);
  assert.equal(reads, 1, 'Question polling must not reparse the same private record for every connection');
  const copy = readQuestion(record.requestId)!; copy.answered = true; copy.options.push('Not saved');
  assert.deepEqual(readQuestion(record.requestId), record);
  assert.deepEqual(JSON.parse(read(file, 'utf8')), record, 'Unsaved mutation must not change durable state');
  saveQuestion({ ...record, answered: true });
  assert.equal(readQuestion(record.requestId)?.answered, true);
});

test('same-size external replacement is visible even when the modification time is preserved', t => {
  const { record, file } = fixture(t); saveQuestion(record);
  fs.utimesSync(file, 1_000_000, 1_000_000); assert.equal(readQuestion(record.requestId)?.room, 'fixture-room');
  const replacement = file + '.replacement'; fs.writeFileSync(replacement, JSON.stringify({ ...record, room: 'changed-room' }));
  fs.utimesSync(replacement, 1_000_000, 1_000_000);
  const before = fs.statSync(file); fs.renameSync(replacement, file);
  assert.equal(fs.statSync(file).size, before.size);
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  assert.equal(readQuestion(record.requestId)?.room, 'changed-room');
});

test('invalid, oversized, missing and mismatched records never return a previous cached question', t => {
  const { record, file } = fixture(t); saveQuestion(record); assert.ok(readQuestion(record.requestId));
  fs.writeFileSync(file, '{broken'); assert.equal(readQuestion(record.requestId), undefined);
  fs.writeFileSync(file, 'x'.repeat(16_385)); assert.equal(readQuestion(record.requestId), undefined);
  fs.writeFileSync(file, JSON.stringify({ ...record, callId: 'different-call' }));
  assert.equal(readQuestion(record.requestId), undefined);
  saveQuestion(record); assert.ok(readQuestion(record.requestId));
  fs.rmSync(file); assert.equal(readQuestion(record.requestId), undefined);
  assert.equal(readQuestion('../unowned-record'), undefined);
});

test('the observation cache evicts old records instead of retaining every historical question', t => {
  const { record, file } = fixture(t); saveQuestion(record); assert.ok(readQuestion(record.requestId));
  for (let index = 0; index < 512; index++) {
    const callId = `historical-${index}`, requestId = questionId(record.sessionId, callId, 0);
    saveQuestion({ ...record, callId, requestId }); assert.ok(readQuestion(requestId));
  }
  const read = fs.readFileSync; let reads = 0;
  t.mock.method(fs, 'readFileSync', (path: fs.PathOrFileDescriptor, options: any) => {
    if (path === file) reads++; return read(path, options);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual(readQuestion(record.requestId), record);
  assert.equal(reads, 1, 'The oldest evicted record is read from durable storage again');
});
