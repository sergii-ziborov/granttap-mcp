import assert from 'node:assert/strict';
import fs, { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { finishScanCooperatively } from '../../../cooperative-scan';
import { parseClaudeFile, parseClaudeFileSteps } from '../parse';
import { claudeSummaryCache } from '../shared';
import { LIVE_MS } from '../../../support/common';

const SESSION = 'a0000000-0000-4000-8000-000000000154';
const record = (at: number, tokens = 3, padding = '') => JSON.stringify({
  type: 'assistant', sessionId: SESSION, agentId: 'native-worker', timestamp: new Date(at).toISOString(), padding,
  message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic result' }],
    usage: { input_tokens: tokens - 1, output_tokens: 1 } },
});

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-transcript-continuity-'));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = join(root, 'config');
  claudeSummaryCache.clear();
  t.after(() => {
    t.mock.restoreAll(); syncBuiltinESMExports(); claudeSummaryCache.clear();
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const parent = join(root, `${SESSION}.jsonl`);
  const children = join(root, SESSION, 'subagents'); mkdirSync(children, { recursive: true });
  return { parent, child: join(children, 'agent-worker.jsonl') };
}

/** Observe real I/O, without replacing transcript data or changing the reader's result. */
function observeReads(t: TestContext, path: string, firstRead: () => void = () => {}) {
  const opened = new Map<number, string>();
  const open = fs.openSync, read = fs.readSync, readFile = fs.readFileSync;
  const probe = { bytes: 0, started: false };
  const consumed = (bytes: number) => {
    probe.bytes += bytes;
    if (!probe.started) { probe.started = true; firstRead(); }
  };
  t.mock.method(fs, 'openSync', (...args: any[]) => {
    const fd = Reflect.apply(open, fs, args) as number; opened.set(fd, String(args[0])); return fd;
  });
  t.mock.method(fs, 'readSync', (...args: any[]) => {
    const bytes = Reflect.apply(read, fs, args) as number;
    if (opened.get(args[0]) === path) consumed(bytes);
    return bytes;
  });
  t.mock.method(fs, 'readFileSync', (...args: any[]) => {
    const value = Reflect.apply(readFile, fs, args);
    if (String(args[0]) === path) consumed(Buffer.byteLength(value));
    return value;
  });
  syncBuiltinESMExports(); return probe;
}

test('a large child transcript lets transport callbacks run before its summary completes', async t => {
  const { parent, child } = fixture(t);
  writeFileSync(parent, record(Date.now(), 3) + '\n');
  writeFileSync(child, Array.from({ length: 2_048 }, () => record(Date.now(), 3, 'x'.repeat(8_192))).join('\n') + '\n');
  let finished = false, callbackDuringRead = false;
  observeReads(t, child, () => { void setImmediate().then(() => { callbackDuringRead = !finished; }); });
  const result = await finishScanCooperatively(parseClaudeFileSteps(parent)); finished = true;
  await setImmediate();
  assert.equal(callbackDuringRead, true, 'a child scan must not starve pongs and decisions');
  assert.equal(result?.session.tokensSession, 3 + 2_048 * 3);
  assert.equal(result?.session.childThreads?.[0]?.threadId, 'native-worker');
});

test('a growing live child preserves the checkpoint of its quiet parent', t => {
  const { parent, child } = fixture(t);
  writeFileSync(parent, record(Date.now() - LIVE_MS - 60_000, 3, 'x'.repeat(2_000_000)) + '\n');
  writeFileSync(child, record(Date.now(), 5) + '\n');
  assert.equal(parseClaudeFile(parent)?.session.tokensSession, 8);
  const reads = observeReads(t, parent);
  appendFileSync(child, record(Date.now(), 7) + '\n');
  assert.equal(parseClaudeFile(parent)?.session.tokensSession, 15);
  assert.ok(reads.bytes <= 512, `quiet parent was reread: ${reads.bytes} bytes`);
});

test('assembling a long native row yields before reading the entire row', async t => {
  const { parent } = fixture(t);
  const body = record(Date.now(), 11, 'x'.repeat(8_000_000)) + '\n'; writeFileSync(parent, body);
  let callbackBeforeCompleteRead = false;
  const reads = observeReads(t, parent, () => {
    // A slow disk slice spends the cooperative budget before the next native read.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 12);
    void setImmediate().then(() => { callbackBeforeCompleteRead = reads.bytes < Buffer.byteLength(body); });
  });
  const result = await finishScanCooperatively(parseClaudeFileSteps(parent)); await setImmediate();
  assert.equal(callbackBeforeCompleteRead, true, 'a large row must not monopolize transport input');
  assert.equal(result?.session.tokensSession, 11);
  assert.equal(parseClaudeFile(parent)?.session.tokensSession, 11, 'the row is never counted twice');
});

test('a child append during a cooperative scan is discovered on the next pass', async t => {
  const { parent, child } = fixture(t);
  writeFileSync(parent, record(Date.now(), 3) + '\n');
  writeFileSync(child, record(Date.now(), 5, 'x'.repeat(2_000_000)) + '\n');
  observeReads(t, child, () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 12);
    void setImmediate().then(() => appendFileSync(child, record(Date.now(), 7) + '\n'));
  });
  await finishScanCooperatively(parseClaudeFileSteps(parent));
  await setImmediate();
  assert.equal(parseClaudeFile(parent)?.session.tokensSession, 15);
});
