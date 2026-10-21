import assert from 'node:assert/strict';
import test from 'node:test';
import { publishMonitorCapabilities, stopMonitorCapabilities } from '..';

test('current execution usage reaches the phone while historical discovery is held', async t => {
  let release!: () => void;
  const history = new Promise<never[]>(resolve => { release = () => resolve([]); });
  let received!: () => void;
  const published = new Promise<void>(resolve => { received = resolve; });
  const client = { room: 'fixture', isConnected: true, send: async (payload: { type: string }) => {
    if (payload.type === 'capability.usage.status') received();
  } };
  t.after(() => { release(); stopMonitorCapabilities(client as never); });
  publishMonitorCapabilities(client as never, { type: 'sessions.status', machine: 'Fixture',
    generatedAt: Date.now(), sessions: [] }, () => history);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([published, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Current usage was held behind closed chat discovery')), 500);
    })]);
    assert.ok(true, 'A real usage payload was sent before history completed');
  } finally { clearTimeout(timer); release(); }
});
