import assert from 'node:assert/strict';
import test from 'node:test';
import type {SessionInfo, SessionsStatus} from '../../../../../../packages/protocol/schema';
import {openChatUpdates, OPEN_CHAT_INTERVAL_MS} from '../../open-chat-updates';

const session = (id = 'chat'): SessionInfo => ({sessionId: id, agent: 'claude', state: 'working',
  startedAt: 1, lastActivityAt: 1, tokensSession: 0, tokensLastTurn: 0});
const catalog = (sessions = [session()]): SessionsStatus => ({type: 'sessions.status', machine: 'Fixture', sessions,
  generatedAt: 1, tokensRecent: 0, tokenWindowHours: 24});

test('open chats publish changed native state without discovery or repeated unchanged heads', async () => {
  let revision = '1', available = true;
  const sent: SessionsStatus[] = [];
  const tick = openChatUpdates({catalog, subscriptions: new Set(['chat']), active: () => available,
    observe: s => ({session: {...s, state: 'idle'}, revision}),
    publish: async (id, status) => {assert.equal(id, 'chat'); sent.push(status); return true}});
  await tick(); await tick();
  assert.equal(sent.length, 1); assert.equal(sent[0]!.sessions[0]!.state, 'idle');
  assert.equal(sent[0]!.generatedAt, 1, 'one chat does not make the full catalog fresh');
  revision = '2'; await tick(); assert.equal(sent.length, 2);
  available = false; revision = '3'; await tick(); assert.equal(sent.length, 2);
  assert.ok(OPEN_CHAT_INTERVAL_MS <= 2_000);
});

test('failed sends retry the same revision and overlapping ticks cannot duplicate an in-flight head', async () => {
  let release!: () => void, attempts = 0;
  const tick = openChatUpdates({catalog, subscriptions: new Set(['chat']), active: () => true,
    observe: s => ({session: s, revision: 'same'}), publish: async () => {
      attempts++; if (attempts === 1) {await new Promise<void>(resolve => {release = resolve}); throw Error('offline')}
      return attempts > 2;
    }});
  const pending = tick(); await new Promise(resolve => setImmediate(resolve));
  await tick(); assert.equal(attempts, 1); release(); await pending;
  await tick(); await tick(); await tick(); assert.equal(attempts, 3);
});

test('bounded round robin reaches every working chat and stops queued reads after close', async () => {
  const sent: string[] = [], sessions = Array.from({length: 20}, (_, i) => session(`chat-${i}`));
  let active = true;
  const tick = openChatUpdates({catalog: () => catalog(sessions), subscriptions: new Set(), active: () => active,
    observe: s => ({session: s, revision: '1'}), publish: async id => {sent.push(id); return true}});
  await tick(); assert.equal(sent.length, 8);
  await tick(); await tick(); assert.equal(new Set(sent).size, 20);
  active = false; await tick(); assert.equal(sent.length, 20);
});

test('the open chat is checked on every pass even when many background chats are working', async () => {
  const sessions = Array.from({length: 40}, (_, i) => session(`chat-${i}`));
  let openedReads = 0;
  const tick = openChatUpdates({catalog: () => catalog(sessions), subscriptions: new Set(['chat-39']), active: () => true,
    observe: s => {if (s.sessionId === 'chat-39') openedReads++; return {session: s, revision: '1'}},
    publish: async () => true});
  await tick(); await tick(); await tick(); assert.equal(openedReads, 3);
});

test('an unknown source or removed subscription never starts discovery or retains an old revision', async () => {
  let subscribed = true, readable = false, sends = 0;
  const subscriptions = new Set(['chat', 'missing']);
  const tick = openChatUpdates({catalog: () => subscribed ? catalog([{...session(), state: 'idle'}]) : undefined,
    subscriptions, active: () => true, observe: s => readable ? {session: s, revision: 'same'} : undefined,
    publish: async () => {sends++; return true}});
  await tick(); assert.equal(sends, 0); readable = true; await tick(); assert.equal(sends, 1);
  subscriptions.clear(); await tick(); subscriptions.add('chat'); await tick(); assert.equal(sends, 2);
  subscribed = false; await tick(); assert.equal(sends, 2);
});
