import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { UserMessage, type SessionInfo } from '../../packages/protocol/schema';
import { rememberPublishedCatalog } from '../../apps/bridge/src/session-catalog';
import { handleUserMessage } from '../../apps/bridge/src/monitor/handlers/user-message';

/** Claude Code and Codex stand-ins that answer with the command line they were started with. */
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-turn-controls-'));
  const claude = join(root, 'claude'), codex = join(root, 'codex');
  writeFileSync(claude, ['#!/usr/bin/env node',
    "process.stdout.write(JSON.stringify({ result: process.argv.slice(2, -1).join(' '), session_id: 'claude-chat' }));",
  ].join('\n'), { mode: 0o755 });
  writeFileSync(codex, ['#!/usr/bin/env node',
    "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'codex-chat' }) + '\\n');",
    "const text = process.argv.slice(2).join(' ');",
    "process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\\n');",
  ].join('\n'), { mode: 0o755 });
  const names = ['GRANTTAP_CONFIG_DIR', 'GRANTTAP_CLAUDE_BIN', 'GRANTTAP_CODEX_BIN'] as const;
  const prior = names.map(name => process.env[name]);
  [root, claude, codex].forEach((value, index) => { process.env[names[index]!] = value; });
  t.after(() => {
    names.forEach((name, index) => {
      if (prior[index] === undefined) delete process.env[name]; else process.env[name] = prior[index];
    });
    rmSync(root, { recursive: true, force: true });
  });
  const said: string[] = [];
  const answer = async (payload: { kind?: string; text?: string }) => {
    if (payload.kind === 'response' && payload.text) said.push(payload.text);
  };
  const client = { room: 'turn-controls-room', isConnected: true, setSessionKey: () => {}, send: answer, sendSession: answer };
  /** What the computer's catalog says about a chat after its turns: the model and effort it ran with. */
  const publish = (session: Partial<SessionInfo> & Pick<SessionInfo, 'sessionId' | 'agent'>) =>
    rememberPublishedCatalog(client as never, { type: 'sessions.status', machine: 'Fixture Mac', generatedAt: Date.now(),
      sessions: [{ state: 'idle', startedAt: 1, lastActivityAt: 2, tokensSession: 0, tokensLastTurn: 0, cwd: root, ...session }] });
  /** The JSON a phone sends, decoded as the monitor decodes it; the last line said is the command line. */
  const send = async (json: Record<string, unknown>) => {
    const message = UserMessage.parse({ type: 'user.message', createdAt: Date.now(), ...json });
    assert.equal(await handleUserMessage(client as never, message), 'accepted');
    return said.at(-1) ?? '';
  };
  return { publish, send };
}

test('a Claude Task created on the phone starts with its chosen model and effort and its next turns keep them', async t => {
  const f = fixture(t);
  const created = await f.send({ messageId: 'new-1', taskOriginId: 'new-1', agent: 'claude', text: 'Start',
    model: 'fable', effort: 'xhigh' });
  assert.match(created, /^-p --session-id [0-9a-f-]{36} --model fable --effort xhigh --output-format json$/);

  // Claude records each request's effort; the catalog reports the chat's latest. On the owner's Mac a
  // follow-up that named nothing ran at Claude Code's headless default, medium, after an xhigh start.
  f.publish({ sessionId: 'claude-chat', agent: 'claude', model: 'claude-fable-5-2', effort: 'xhigh' });
  const bare = await f.send({ messageId: 'next-1', sessionId: 'claude-chat', agent: 'claude', text: 'Go on' });
  assert.equal(bare, '-p --resume claude-chat --effort xhigh --output-format json');

  const chosen = await f.send({ messageId: 'next-2', sessionId: 'claude-chat', agent: 'claude', text: 'Go on',
    model: 'fable', effort: 'xhigh' });
  assert.equal(chosen, '-p --resume claude-chat --model fable --effort xhigh --output-format json');

  const lowered = await f.send({ messageId: 'next-3', sessionId: 'claude-chat', agent: 'claude', text: 'Go on',
    model: 'sonnet', effort: 'low' });
  assert.equal(lowered, '-p --resume claude-chat --model sonnet --effort low --output-format json',
    'a level chosen for the turn wins over the one the chat ran with');

  // Claude Code retries a level a model refuses without it, so another model keeps the chat's effort too.
  const switched = await f.send({ messageId: 'next-4', sessionId: 'claude-chat', agent: 'claude', text: 'Go on',
    model: 'sonnet' });
  assert.equal(switched, '-p --resume claude-chat --model sonnet --effort xhigh --output-format json');
});

test('a Claude Task created on the phone runs its first turn in the permission mode New Task chose', async t => {
  // On 23 November 2026 a Task created with Bypass permissions started as `claude -p --session-id … --output-format
  // json`: the first turn asked for every tool, and only the second ran with `--permission-mode bypassPermissions`.
  const f = fixture(t);
  const created = await f.send({ messageId: 'mode-new', taskOriginId: 'mode-new', agent: 'claude', text: 'Start',
    permissionMode: 'bypassPermissions', effort: 'high' });
  assert.match(created, /^-p --session-id [0-9a-f-]{36} --permission-mode bypassPermissions --effort high --output-format json$/);
  const plain = await f.send({ messageId: 'mode-none', taskOriginId: 'mode-none', agent: 'claude', text: 'Start' });
  assert.match(plain, /^-p --session-id [0-9a-f-]{36} --output-format json$/, 'a Task that chose nothing starts as before');
});

test('a Claude chat that reported no effort, or one Claude does not have, resumes as it always did', async t => {
  const f = fixture(t);
  f.publish({ sessionId: 'claude-chat', agent: 'claude', model: 'claude-opus-5-5' });
  assert.equal(await f.send({ messageId: 'bare-1', sessionId: 'claude-chat', agent: 'claude', text: 'Go on' }),
    '-p --resume claude-chat --output-format json');
  f.publish({ sessionId: 'claude-chat', agent: 'claude', model: 'claude-opus-5-5', effort: 'ultra' });
  assert.equal(await f.send({ messageId: 'bare-2', sessionId: 'claude-chat', agent: 'claude', text: 'Go on' }),
    '-p --resume claude-chat --output-format json');
});

test('a Codex Task created on the phone keeps its effort on resume until a turn switches its model', async t => {
  const f = fixture(t);
  const created = await f.send({ messageId: 'codex-new', taskOriginId: 'codex-new', agent: 'codex', text: 'Start',
    model: 'gpt-6.2-sol', effort: 'low' });
  assert.match(created, /^exec -m gpt-6\.2-sol -c model_reasoning_effort="low" --json --skip-git-repo-check -$/);

  // Without the flag `codex exec resume` takes config.toml's effort, not the chat's.
  f.publish({ sessionId: 'codex-chat', agent: 'codex', model: 'gpt-6.2-sol', effort: 'low' });
  const bare = await f.send({ messageId: 'codex-next-1', sessionId: 'codex-chat', agent: 'codex', text: 'Go on' });
  assert.match(bare, /^exec resume -c model_reasoning_effort="low" codex-chat --json/);

  const same = await f.send({ messageId: 'codex-next-2', sessionId: 'codex-chat', agent: 'codex', text: 'Go on',
    model: 'gpt-6.2-sol' });
  assert.match(same, /^exec resume -m gpt-6\.2-sol -c model_reasoning_effort="low" codex-chat --json/);

  // Codex levels differ by model (its luna models have no ultra), so a switch keeps nothing it did not choose.
  const switched = await f.send({ messageId: 'codex-next-3', sessionId: 'codex-chat', agent: 'codex', text: 'Go on',
    model: 'gpt-6-luna' });
  assert.match(switched, /^exec resume -m gpt-6-luna codex-chat --json/);
});
