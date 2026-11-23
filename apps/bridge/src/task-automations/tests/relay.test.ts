import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { SessionInfo, TaskAutomationsResult, UserMessage } from '../../../../../packages/protocol/schema';
import { rememberPublishedCatalog } from '../../session-catalog';
import { handleTaskAutomations, startTaskAutomations } from '..';
import { useAutomationControls } from '../controls/relay';
import { readAutomations } from '../store';
import { chat, isolatedComputer } from './fixture';

/** A paired computer whose monitor published `sessions`, with a client that records what it sends. */
function pairedComputer(t: { after: (fn: () => void) => void }, sessions: SessionInfo[]) {
  const { root, path } = isolatedComputer(t), prior = process.env.HOME;
  process.env.HOME = join(root, 'home'); mkdirSync(process.env.HOME);
  t.after(() => { if (prior === undefined) delete process.env.HOME; else process.env.HOME = prior; });
  const machine = join(root, 'machine.json');
  writeFileSync(machine, JSON.stringify({ room: 'paired-room', role: 'machine', peerPublicKey: 'phone', extraPeerPublicKeys: ['ipad'] }));
  const results: { value: TaskAutomationsResult; session: string; options: any }[] = [], sent: any[] = [];
  const client: any = { room: 'paired-room', isConnected: true, setSessionKey() {},
    send: async (value: unknown) => { sent.push(value); },
    sendSession: async (value: any, session: string, _to: string, options: any) => {
      if (value.type === 'task.automations.result') results.push({ value, session, options }); else sent.push(value);
    } };
  rememberPublishedCatalog(client, { type: 'sessions.status', machine: 'QA Mac', sessions, generatedAt: Date.now() });
  useAutomationControls(undefined);
  t.after(() => useAutomationControls(undefined));
  return { client, results, sent, path, machine };
}

const ask = (sessionId: string, action?: unknown, requestId = `r-${Math.random()}`) =>
  ({ type: 'task.automations' as const, requestId, sessionId, createdAt: Date.now(), ...(action ? { action: action as any } : {}) });

test("only a paired phone can list and change a published chat's automations, and only it hears back", async t => {
  const claude = chat('claude-root'), codex = chat('codex-sibling', { agent: 'codex' }), other = chat('other', { taskId: 'other' });
  const { client, results, machine } = pairedComputer(t, [claude, codex, other]);
  const create = ask(claude.sessionId, { kind: 'create', draft: { name: 'Nightly', prompt: 'Run the checks.',
    schedule: { kind: 'daily', hour: 2, minute: 0, weekdays: ['MO', 'TU'] } } });
  assert.equal(await handleTaskAutomations(client, create, undefined), false);
  assert.equal(await handleTaskAutomations(client, create, 'stranger'), false);
  assert.equal(await handleTaskAutomations({ ...client, room: 'other-room' }, create, 'phone'), false);
  assert.equal(await handleTaskAutomations(client, { ...create, sessionId: 'unpublished' }, 'phone'), false);
  assert.equal(await handleTaskAutomations(client, { ...create, createdAt: 0 }, 'phone'), false);
  assert.equal(results.length, 0);
  assert.equal(await handleTaskAutomations(client, create, 'ipad'), true);
  const [answer] = results;
  assert.equal(answer!.value.phase, 'completed');
  assert.deepEqual(answer!.value.automations.map(row => [row.name, row.agent, row.sessionId]), [['Nightly', 'claude', 'claude-root']]);
  assert.deepEqual([answer!.session, answer!.options], ['claude-root',
    { peerPublicKey: 'ipad', reliable: false, urgent: true, ttlMs: 30_000 }]);
  assert.deepEqual(readAutomations().automations.map(row => [row.projectId, row.taskId]), [['project', 'task']]);
  // The Codex chat of the same Task lists it; another Task does not.
  await handleTaskAutomations(client, ask(codex.sessionId), 'phone');
  assert.equal(results.at(-1)!.value.automations.length, 1);
  await handleTaskAutomations(client, ask(other.sessionId), 'phone');
  assert.deepEqual(results.at(-1)!.value.automations, []);
  rmSync(machine);
  assert.equal(await handleTaskAutomations(client, ask(claude.sessionId), 'phone'), false, 'an unpaired computer answers nothing');
});

test('the monitor runs a due automation in a free chat it published, and stops when told', async t => {
  const claude = chat('monitored-chat');
  const { client, path } = pairedComputer(t, [claude]);
  const delivered: UserMessage[] = [];
  let leader = false, held = false;
  const stop = startTaskAutomations({ client, isLeader: () => leader, held: () => held, publish: async () => {},
    deliver: async message => { delivered.push(message); return undefined; } });
  t.after(stop);
  await handleTaskAutomations(client, ask(claude.sessionId, { kind: 'create', draft: { name: 'Soon', prompt: 'Look now.',
    schedule: { kind: 'hours', every: 1 } } }), 'phone');
  const [row] = readAutomations(path).automations;
  await handleTaskAutomations(client, ask(claude.sessionId, { kind: 'run', id: row!.id }), 'phone');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(delivered.length, 0, 'a monitor that does not lead phone routing runs nothing');
  leader = true; held = true;
  await handleTaskAutomations(client, ask(claude.sessionId), 'phone');
  await handleTaskAutomations(client, ask(claude.sessionId, { kind: 'run', id: row!.id }), 'phone');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(delivered.length, 0, 'nothing new starts while an update drains the monitor');
  assert.equal(readAutomations(path).automations[0]!.waiting?.reason, 'update');
  held = false;
  await handleTaskAutomations(client, ask(claude.sessionId, { kind: 'run', id: row!.id }), 'phone');
  for (let wait = 0; wait < 40 && !delivered.length; wait++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(delivered.map(message => [message.text, message.sessionId]), [['Look now.', 'monitored-chat']]);
});

test("a run for a chat this computer no longer has is refused by delivery, as a phone message would be", async t => {
  const listed = chat('listed-chat');
  const { client, path } = pairedComputer(t, [listed]);
  await handleTaskAutomations(client, ask(listed.sessionId, { kind: 'create', draft: { name: 'Orphan', prompt: 'Hello?',
    schedule: { kind: 'hours', every: 1 } } }), 'phone');
  // The chat leaves this computer: a fresh catalog no longer lists it.
  rememberPublishedCatalog(client, { type: 'sessions.status', machine: 'QA Mac', sessions: [], generatedAt: Date.now() });
  const state = readAutomations(path);
  state.automations[0]!.pending = { dueAt: Date.now(), since: Date.now(), manual: true };
  writeFileSync(path, JSON.stringify({ version: 1, automations: state.automations }));
  const stop = startTaskAutomations({ client, isLeader: () => true, publish: async () => {} });
  t.after(stop);
  for (let wait = 0; wait < 200 && readAutomations(path).automations[0]!.last?.outcome !== 'failed'; wait++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.deepEqual(readAutomations(path).automations[0]!.last?.reason, 'This task is no longer available on the computer.');
});
