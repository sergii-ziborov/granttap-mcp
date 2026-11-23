import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A stand-in `claude` that prints what Claude Code 2.1.330 printed for a headless `/compact` on a
 * throwaway chat (the rows are copied from that run, ids shortened), or one of its refusals. Each call
 * is written down with its arguments and folder, so a test can tell whether a compaction ran at all.
 */
const script = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('2.1.330 (Claude Code)\n'); process.exit(0); }
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\n');
const mode = process.env.FAKE_CLAUDE_MODE || 'success';
const id = args[args.indexOf('--resume') + 1];
const out = (row) => process.stdout.write(JSON.stringify({ session_id: id, ...row }) + '\n');
setTimeout(() => {
  if (mode === 'missing') {
    process.stderr.write('No conversation found with session ID: ' + id + '\n');
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: ' + id] });
    process.exit(1);
  }
  out({ type: 'system', subtype: 'status', status: 'compacting' });
  if (mode === 'failed') {
    out({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'Not enough messages to compact.' });
    out({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: '' });
    return;
  }
  out({ type: 'system', subtype: 'status', status: null, compact_result: 'success' });
  out({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: [] });
  out({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 612002, post_tokens: 31400, duration_ms: 9000 } });
  out({ type: 'user', message: { role: 'user', content: 'This session is being continued from a previous conversation. Summary: synthetic' } });
  out({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' }, isReplay: true });
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: '' });
}, Number(process.env.FAKE_CLAUDE_DELAY_MS || 0));
`;

export type FakeClaude = { bin: string; root: string; calls: () => Array<{ args: string[]; cwd: string }>; done: () => void };

/** Points `GRANTTAP_CLAUDE_BIN` at the stand-in for one test; `done` puts the environment back. */
export function fakeClaude(mode = 'success'): FakeClaude {
  const root = mkdtempSync(join(tmpdir(), 'granttap-fake-claude-'));
  const bin = join(root, 'claude.cjs');
  const log = join(root, 'calls.jsonl');
  writeFileSync(bin, script, { mode: 0o755 });
  writeFileSync(log, '');
  const prior = { bin: process.env.GRANTTAP_CLAUDE_BIN, log: process.env.FAKE_CLAUDE_LOG, mode: process.env.FAKE_CLAUDE_MODE };
  Object.assign(process.env, { GRANTTAP_CLAUDE_BIN: bin, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_MODE: mode });
  const restore = (key: string, value: string | undefined) => { if (value == null) delete process.env[key]; else process.env[key] = value; };
  return {
    bin, root,
    calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    done: () => {
      restore('GRANTTAP_CLAUDE_BIN', prior.bin); restore('FAKE_CLAUDE_LOG', prior.log); restore('FAKE_CLAUDE_MODE', prior.mode);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
