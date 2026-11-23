import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { chatHold, FRESH_CATALOG_MS } from '../runner';
import { AutomationStoreError, readAutomations, wireAutomation, writeAutomations } from '../store';
import { chat, fakeComputer, hour, isolatedComputer, minute } from './fixture';

const start = Date.UTC(2026, 10, 23, 8, 0);

test('a restarted monitor keeps the schedule, the run waiting and what ran, and never sends a run twice', async t => {
  const { path } = isolatedComputer(t), computer = fakeComputer(path, start), claude = chat('restart-chat');
  computer.world.chats.set(claude.sessionId, { ...claude, state: 'working' });
  const created = await computer.create(claude, { kind: 'hours', every: 1 });
  await computer.pass(start + hour);
  computer.restart();
  computer.world.chats.set(claude.sessionId, claude);
  await computer.pass(start + hour + 15_000);
  assert.equal(computer.world.sent.length, 1, 'the run that waited before the restart goes after it');
  computer.restart();
  await computer.pass(start + hour + 30_000);
  assert.equal(computer.world.sent.length, 1, 'a run recorded as ran is not sent again by the next monitor');
  const listed = await computer.ask(claude);
  assert.deepEqual([listed.automations[0].id, listed.automations[0].nextRunAt, listed.automations[0].last.outcome],
    [created.id, start + 2 * hour, 'ran']);
});

test('saved automations that cannot be read, or that a newer GrantTap wrote, are never replaced', async t => {
  const { path } = isolatedComputer(t), computer = fakeComputer(path, start), claude = chat('kept-chat');
  writeFileSync(path, JSON.stringify({ version: 2, automations: [] }));
  const answer = await computer.ask(claude, { kind: 'create', draft: { name: 'x', prompt: 'x', schedule: { kind: 'hours', every: 1 } } });
  assert.deepEqual([answer.phase, answer.message], ['failed', 'The saved automations on this computer cannot be read. Nothing was changed.']);
  await computer.pass(start + minute);
  await computer.pass(start + 2 * minute);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 2, automations: [] });
  assert.equal(computer.world.lines.length, 1, 'the runner says so once, not every pass');
  assert.match(computer.world.lines[0]!, /^\[monitor\] Automations wait: the saved automations are in a format this GrantTap does not know; /);
  writeFileSync(path, '{');
  assert.throws(() => readAutomations(path), AutomationStoreError);
  writeFileSync(path, JSON.stringify({ version: 1, automations: [] }));
  chmodSync(path, 0o000);
  try { if (process.getuid?.() !== 0) assert.throws(() => readAutomations(path), /could not be read \(EACCES\)/); }
  finally { chmodSync(path, 0o600); }
});

test('rows a newer GrantTap added are kept as they are when this one saves', async t => {
  const { path } = isolatedComputer(t), computer = fakeComputer(path, start), claude = chat('future-chat');
  const future = { id: 'gta-ffffffffffffffff', schedule: { kind: 'lunar' }, sessionId: claude.sessionId };
  writeFileSync(path, JSON.stringify({ version: 1, automations: [future] }));
  await computer.create(claude, { kind: 'hours', every: 1 });
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.automations.length, 2);
  assert.deepEqual(saved.automations[1], future);
  assert.equal((await computer.ask(claude)).automations.length, 1);
  const state = readAutomations(path);
  state.kept = Array.from({ length: 256 }, () => future);
  assert.throws(() => writeAutomations(state, path), /most automations it can/);
});

test('a chat is free only in a fresh catalog, idle, with nothing ahead of it; one the catalog lacks is left to delivery', () => {
  const now = start, session = chat('hold-chat');
  const free = { agent: 'claude' as const, session, catalogAt: now, inFlight: false, paused: false, queued: 0,
    updating: false, continuation: false, readings: [] };
  assert.equal(chatHold(free, now), undefined);
  assert.equal(chatHold({ ...free, session: undefined }, now), undefined);
  assert.deepEqual(chatHold({ ...free, catalogAt: now - FRESH_CATALOG_MS - 1 }, now), { reason: 'checking' });
  assert.deepEqual(chatHold({ ...free, catalogAt: undefined }, now), { reason: 'checking' });
  assert.deepEqual(chatHold({ ...free, paused: true }, now), { reason: 'paused' });
  assert.deepEqual(chatHold({ ...free, session: { ...session, state: 'waiting' } }, now), { reason: 'busy' });
  assert.deepEqual(chatHold({ ...free, queued: 1 }, now), { reason: 'queued' });
  assert.deepEqual(chatHold({ ...free, continuation: true }, now), { reason: 'continuation' });
  const codex = { ...free, agent: 'codex' as const, session: { ...session, agent: 'codex', usageLimit: { resetsAt: now + hour } } };
  assert.deepEqual(chatHold(codex, now), { reason: 'limit', until: now + hour + minute }, 'a Codex limit holds its chat too');
  assert.equal(chatHold({ ...codex, session: { ...codex.session, usageLimit: { resetsAt: now - 2 * minute } } }, now), undefined);
});

test('the phone sees where a waiting run stands, without the Task or anchor the computer keeps', async t => {
  const { path } = isolatedComputer(t), computer = fakeComputer(path, start), claude = chat('wire-chat');
  await computer.create(claude, { kind: 'hours', every: 1 });
  const [row] = readAutomations(path).automations;
  const wire = wireAutomation({ ...row!, pending: { dueAt: start, since: start, manual: true }, waiting: { reason: 'limit', until: start + hour } });
  assert.deepEqual(wire.waiting, { dueAt: start, reason: 'limit', until: start + hour, manual: true });
  assert.equal('anchorAt' in wire || 'projectId' in wire || 'taskId' in wire || 'pending' in wire, false);
});
