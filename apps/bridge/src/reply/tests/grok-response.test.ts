import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { runGrokResume } from '../process/provider-headless';

async function response(events: unknown[], exit = 0) {
  const root = await mkdtemp(join(tmpdir(), 'granttap-grok-response-'));
  const before = process.env.GRANTTAP_GROK_BIN;
  const bin = join(root, 'grok');
  await writeFile(bin, '#!/usr/bin/env node\n'
    + `process.stdout.write(${JSON.stringify(events.map(e => JSON.stringify(e)).join('\n') + '\n')});\n`
    + `process.exit(${exit});\n`, { mode: 0o755 });
  process.env.GRANTTAP_GROK_BIN = bin;
  try {
    return await runGrokResume({ agent: 'grok', sessionId: 'fixture', cwd: root,
      state: 'idle', startedAt: 1, lastActivityAt: 1, tokensSession: 0, tokensLastTurn: 0 },
    'Synthetic response check', 2_000);
  } finally {
    if (before === undefined) delete process.env.GRANTTAP_GROK_BIN;
    else process.env.GRANTTAP_GROK_BIN = before;
    await rm(root, { recursive: true, force: true });
  }
}

test('Grok thinking and tool execution confirm delivery even if the run later fails', async () => {
  for (const event of [{ type: 'thought', data: 'Synthetic thinking' },
    { type: 'tool_call', toolCallId: 'fixture-call', status: 'in_progress' }]) {
    const result = await response([event], 1);
    assert.equal(result.ok, false);
    assert.equal(result.delivery, 'native');
  }
});

test('Grok diagnostics and metadata do not masquerade as an answer or admission', async () => {
  const result = await response([{ type: 'available_commands', tools: [] },
    { type: 'end', sessionId: 'fixture' }]);
  assert.equal(result.ok, false);
  assert.equal(result.delivery, undefined);
});

test('Grok native error message is preserved as a failure, not JSON answer text', async () => {
  const result = await response([{ type: 'error', message: 'Synthetic provider refusal' }]);
  assert.deepEqual(result, { ok: false, error: 'Synthetic provider refusal' });
});

test('a streamed Grok usage refusal stays an actionable failure without admission', async () => {
  const result = await response([{ type: 'error', message: 'Grok Build usage balance exhausted' }]);
  assert.deepEqual(result, { ok: false,
    error: 'Grok usage limit reached: Grok Build usage balance exhausted. Check your Grok usage before retrying.' });
});

test('Grok streaming text still yields the real answer and session', async () => {
  const result = await response([{ type: 'text', data: 'Synthetic ' },
    { type: 'text', data: 'answer' }, { type: 'end', sessionId: 'fixture' }]);
  assert.deepEqual(result, { ok: true, text: 'Synthetic answer', sessionId: 'fixture' });
});
