import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Payload } from '../../../../../packages/protocol/schema';
import { localTaskTransfers } from '../../task-transfer';
import { boundedCatalogHistory, publishSessionEvents } from '../../monitor';
import { scanSessionHistory } from '../index';

async function fixture(run: (preparedId: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-transferred-catalog-'));
  const previous = [process.env.GRANTTAP_CONFIG_DIR, process.env.GRANTTAP_GROK_SESSIONS_DIR];
  process.env.GRANTTAP_CONFIG_DIR = join(root, 'config');
  process.env.GRANTTAP_GROK_SESSIONS_DIR = join(root, 'sessions');
  const now = Date.now();
  const history = (id: string, hours: number) => {
    const directory = join(root, 'sessions', 'project', id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'summary.json'), JSON.stringify({
      info: { id, cwd: join(root, 'repo') }, generated_title: 'Synthetic task',
      created_at: now - 72 * 3_600_000, updated_at: now - hours * 3_600_000,
    }));
    writeFileSync(join(directory, 'chat_history.jsonl'), JSON.stringify({
      role: 'assistant', content: 'Synthetic visible answer', timestamp: now - hours * 3_600_000,
    }) + '\n');
  };
  try {
    for (let index = 0; index < 45; index++) history(`ordinary-${index}`, 48 + index);
    history('native-destination', 18);
    const transfers = localTaskTransfers();
    const prepared = transfers.prepare({
      eventId: 'catalog-handoff', projectId: 'fixture-project', sourceSessionId: 'source-claude',
      title: 'Transferred task', workspace: join(root, 'repo'), branch: 'granttap/fixture',
      context: 'Synthetic prior visible context', acceptedAt: now - 20 * 3_600_000,
      capsule: { taskId: 'stable-task', goal: 'Verify transfer', currentStatus: 'Ready',
        sourceProvider: 'claude', sourceComputer: 'fixture-computer',
        targetProvider: 'grok', targetComputer: 'fixture-computer',
        repository: 'fixture-repository', baseSha: 'a'.repeat(40), workingTree: 'clean',
        filesChanged: [], dependencies: [], resourceClaims: [], remainingWork: ['Verify'],
        importantDecisions: [], createdAt: now - 20 * 3_600_000 },
    });
    await transfers.deliver(prepared.sessionId, 'Synthetic first turn', [], {}, {
      start: async () => ({ ok: true, sessionId: 'native-destination', text: 'Synthetic answer' }),
      resume: async () => { throw new Error('This test must never run a second provider turn'); },
    });
    await run(prepared.sessionId);
  } finally {
    for (const [index, key] of ['GRANTTAP_CONFIG_DIR', 'GRANTTAP_GROK_SESSIONS_DIR'].entries()) {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test('a transferred Grok chat ranks by native activity before the phone history limit', async () => {
  await fixture(async preparedId => {
    const history = scanSessionHistory();
    const published = boundedCatalogHistory(history);
    assert.equal(published.length, 40, 'The catalog frame stays bounded');
    assert.ok(published.some(row => row.sessionId === preparedId),
      'The newer transferred chat must not disappear behind forty older native chats');
    assert.equal(published[0]?.sessionId, preparedId);
    assert.equal(published[0]?.taskId, 'stable-task');
    assert.equal(history.filter(row => row.sessionId === preparedId).length, 1);
    assert.equal(history.some(row => row.sessionId === 'native-destination'), false,
      'The native alias must not mint another Task');
  });
});

test('an explicit transferred Grok chat request reads its existing native history without a new turn', async () => {
  await fixture(async preparedId => {
    const sent: Payload[] = [];
    const client = { room: 'transferred-chat-fixture',
      setSessionKey() {}, async send(payload: Payload) { sent.push(payload); },
      async sendSession(payload: Payload) { sent.push(payload); } };
    assert.equal(await publishSessionEvents(client as never, preparedId), true);
    const activity = sent.find(payload => payload.type === 'session.activity');
    assert.ok(activity?.type === 'session.activity');
    assert.equal(activity.sessionId, preparedId);
    assert.equal(activity.agent, 'grok');
    assert.ok(activity.entries.some(entry => entry.text === 'Synthetic visible answer'));
  });
});
