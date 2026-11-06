import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { publishSessionEvents } from '../catalog';
import { handleUserMessage } from '../user-message';
import { publishSessionImage } from '../../../session-images';
import { claudeSummaryCache } from '../../../sessions/scan/claude/shared';

const SESSION = 'd0000000-0000-4000-8000-000000000154';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-request-discovery-'));
  const projects = join(root, 'projects'); mkdirSync(projects);
  const environment = { GRANTTAP_CONFIG_DIR: root, GRANTTAP_CLAUDE_PROJECTS_DIR: projects };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment); claudeSummaryCache.clear();
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    claudeSummaryCache.clear(); rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(projects, `${SESSION}.jsonl`), JSON.stringify({ type: 'user', sessionId: SESSION,
    uuid: 'synthetic-user', timestamp: new Date().toISOString(), padding: 'x'.repeat(1_000_000),
    message: { role: 'user', content: 'Synthetic request' } }) + '\n');
  const delivered: any[] = [];
  const client = { room: 'synthetic-cold-discovery', setSessionKey: () => {}, send: async () => {},
    sendSession: async (payload: unknown) => { delivered.push(payload); } };
  return { client: client as never, delivered };
}

test('a cold transcript request services pending transport input during discovery', async t => {
  const { client, delivered } = fixture(t);
  let transportRan = false;
  void setImmediate().then(() => { transportRan = true; });
  assert.equal(await publishSessionEvents(client, SESSION), true);
  assert.equal(transportRan, true, 'request discovery must yield to the network');
  assert.equal(delivered[0].sessionId, SESSION);
  assert.equal(delivered[0].entries.some((entry: any) => entry.text === 'Synthetic request'), true);
});

test('a missing message target services transport before returning its refusal', async t => {
  const { client, delivered } = fixture(t);
  let transportRan = false;
  void setImmediate().then(() => { transportRan = true; });
  assert.equal(await handleUserMessage(client, { type: 'user.message', sessionId: 'missing-chat',
    text: 'Synthetic follow-up', createdAt: Date.now() }), 'rejected');
  assert.equal(transportRan, true, 'a stale phone target cannot block pongs behind a synchronous scan');
  assert.match(delivered[0].text, /no longer available/);
});

test('a missing image target services transport before its unavailable reply', async t => {
  const { client, delivered } = fixture(t);
  let transportRan = false;
  void setImmediate().then(() => { transportRan = true; });
  assert.equal(await publishSessionImage(client, { type: 'session.image.query', sessionId: 'missing-chat',
    requestId: 'synthetic-image', imageId: 'unknown', offset: 0, createdAt: Date.now() }), false);
  assert.equal(transportRan, true);
  assert.equal(delivered[0].unavailable, true);
});
