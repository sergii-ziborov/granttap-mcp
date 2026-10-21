import test from 'node:test';
import assert from 'node:assert/strict';
import { publishCatalogHeads } from '../../../../apps/bridge/src/session-catalog/publish-heads';

test('relay chat heads publish for visible tasks while the phone has no subscriptions', async () => {
  const sent: string[] = [];
  const client = { isConnected: true, supportsRetainedState: true };
  publishCatalogHeads(client as never, { type: 'sessions.status', machine: 'Fixture', generatedAt: Date.now(),
    sessions: [{ sessionId: 'active-task' }, { sessionId: 'second-task' }] } as never,
    new Set(), async (_client, id) => { sent.push(id); });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(sent, ['active-task', 'second-task']);
});
