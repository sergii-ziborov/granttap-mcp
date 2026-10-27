import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Payload, UserMessage } from '../../../../../../../packages/protocol/schema';
import { saveRuntimeConfig } from '../../../../config';
import { inspectRepository } from '../../../catalog';
import { computerId } from '../../../identity/computer';
import { localMeshStore } from '../../../local-remote/local';
import { handleUserMessage } from '../../../../monitor/handlers/user-message';
import { rememberRestrictions } from '../../index';

test('new phone Task receives guidance only after matching workspace admission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-guidance-new-task-'));
  const repo = join(root, 'repo');
  const sessions = join(root, 'sessions');
  const session = join(sessions, 'demo', 'grok-fixture');
  mkdirSync(repo); mkdirSync(session, { recursive: true });
  writeFileSync(join(session, 'summary.json'), JSON.stringify({
    info: { id: 'grok-fixture', cwd: repo }, generated_title: 'Demo fixture',
    created_at: Date.now() - 1000, updated_at: Date.now(), current_model_id: 'grok-build',
  }));
  writeFileSync(join(session, 'chat_history.jsonl'), JSON.stringify({ role: 'user',
    timestamp: Date.now(), content: 'Safe fixture' }) + '\n');
  const bin = join(root, 'grok-fixture.mjs');
  writeFileSync(bin, [
    '#!/usr/bin/env node', 'const args = process.argv.slice(2);',
    "console.log(JSON.stringify({type:'text', data:args[args.indexOf('-p')+1]}));",
    "console.log(JSON.stringify({type:'end',sessionId:args[args.indexOf('--session-id')+1]}));",
  ].join('\n'), { mode: 0o755 });
  process.env.GRANTTAP_CONFIG_DIR = join(root, 'config');
  process.env.GRANTTAP_GROK_SESSIONS_DIR = sessions;
  process.env.GRANTTAP_GROK_BIN = bin;
  saveRuntimeConfig({ providerSettings: { claude: true, codex: true, cursor: true, grok: true } });
  const repositoryId = inspectRepository(repo).canonicalRepositoryId;
  const store = localMeshStore();
  store.upsertProject({ projectId: 'demo', name: 'Demo', canonicalRepositoryId: repositoryId, createdAt: 1 });
  store.upsertBinding({ bindingId: 'demo-local', projectId: 'demo', endpointId: computerId(),
    repositoryId, displayName: 'Demo', localPathHint: repo, available: true });
  rememberRestrictions('demo', { projectId: 'demo', revision: 1, scope: 'project', source: 'phone',
    rules: [], guidance: { principles: ['behavior_tests'], architecture: 'clean', markdown: '**Fixture only**' } });
  const sent: Payload[] = [];
  const relay = { room: 'demo-test-room', isConnected: true,
    setSessionKey: (_session: string, _key: string) => undefined,
    send: async (payload: Payload) => { sent.push(payload); },
    sendSession: async (payload: Payload) => { sent.push(payload); } };
  const message: UserMessage = { type: 'user.message', text: 'Inspect this demo.', cwd: repo,
    agent: 'grok', projectId: 'demo', createdAt: Date.now() };
  assert.equal(await handleUserMessage(relay as never, message), 'accepted');
  const answer = sent.find(item => item.type === 'agent.event' && item.kind === 'response');
  assert.equal(answer?.type, 'agent.event');
  if (answer?.type !== 'agent.event') return;
  assert.match(answer.text, /Clean Architecture/);
  assert.match(answer.text, /\*\*Fixture only\*\*/);
  assert.ok(answer.text.endsWith(message.text));
  assert.equal(message.text, 'Inspect this demo.');
  assert.equal(await handleUserMessage(relay as never, { ...message, projectId: 'unrelated' }), 'rejected');
  assert.match(JSON.stringify(sent.at(-1)), /different Project/);
});
