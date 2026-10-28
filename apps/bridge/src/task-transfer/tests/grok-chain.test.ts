import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { captureTransferContext, localTaskTransfers } from '../index';
import { scanGrok } from '../../sessions/scan/grok';
import type { TaskCapsule } from '../../../../../packages/protocol/schema';

test('a second Grok transfer captures the admitted native conversation and all inherited history pages', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-grok-chain-'));
  const previous = { config: process.env.GRANTTAP_CONFIG_DIR, grok: process.env.GRANTTAP_GROK_SESSIONS_DIR };
  process.env.GRANTTAP_CONFIG_DIR = root;
  process.env.GRANTTAP_GROK_SESSIONS_DIR = join(root, 'native');
  t.after(() => {
    for (const [key, value] of [['GRANTTAP_CONFIG_DIR', previous.config], ['GRANTTAP_GROK_SESSIONS_DIR', previous.grok]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const capsule: TaskCapsule = { taskId: 'chain-task', goal: 'Synthetic transfer verification', currentStatus: 'Idle',
    sourceProvider: 'claude', sourceComputer: 'fixture', targetProvider: 'grok', targetComputer: 'fixture',
    repository: 'fixture', baseSha: 'a'.repeat(40), filesChanged: [], dependencies: [],
    resourceClaims: [], remainingWork: [], importantDecisions: [], createdAt: 1 };
  const inherited = Array.from({ length: 45 }, (_, index) => ({ id: `older-${index}`, role: 'user',
    text: `Inherited request ${index}`, at: index + 1 }));
  const transfers = localTaskTransfers();
  const prepared = transfers.prepare({ eventId: 'synthetic-chain', projectId: 'chain-project',
    sourceSessionId: 'original-claude', title: 'Transfer verification', capsule,
    context: JSON.stringify({ version: 1, facts: capsule, entries: inherited }),
    workspace: '/fixture/worktree', branch: 'codex/fixture', acceptedAt: 50 });
  await transfers.deliver(prepared.sessionId, 'Synthetic native request', [], {}, {
    start: async request => { request.onNativeSession('native-grok'); return { ok: true, text: 'Synthetic native answer', sessionId: 'native-grok' }; },
    resume: async () => ({ ok: false, error: 'Not used' }),
  });
  const directory = join(root, 'native', 'fixture', 'native-grok');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'summary.json'), JSON.stringify({ info: { id: 'native-grok' },
    created_at: new Date().toISOString(), updated_at: new Date().toISOString() }));
  const updates = [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Synthetic native request' }, _meta: { promptIndex: 0 } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Synthetic native answer' } },
    { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' },
  ];
  writeFileSync(join(directory, 'updates.jsonl'), updates.map(update => JSON.stringify({
    timestamp: Date.now() - 100, method: 'session/update', params: { sessionId: 'native-grok', update },
  })).join('\n') + '\n');
  const source = transfers.catalog(scanGrok().sessions).find(row => row.sessionId === prepared.sessionId)!;
  const captured = await captureTransferContext({ ...source, state: 'idle' }, { ...capsule, sourceProvider: 'grok', targetProvider: 'claude' });
  const entries = JSON.parse(captured.context).entries;
  assert.equal(entries.length, 47);
  assert.deepEqual(entries.slice(0, 45).map((entry: any) => entry.text), inherited.map(entry => entry.text));
  assert.deepEqual(entries.slice(-2).map((entry: any) => entry.text), ['Synthetic native request', 'Synthetic native answer']);
});
