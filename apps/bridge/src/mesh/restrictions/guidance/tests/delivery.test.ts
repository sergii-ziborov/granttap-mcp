import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { rememberRestrictions, runRestrictionsCheck } from '../../index';
import { deliverToSession } from '../../../../reply';
import type { SessionInfo } from '../../../../../../../packages/protocol/schema';

test('the resumed provider process receives persisted guidance and the original request once', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-guidance-delivery-'));
  process.env.GRANTTAP_CONFIG_DIR = join(root, 'config');
  const stub = join(root, 'codex-fixture.mjs');
  writeFileSync(stub, [
    "#!/usr/bin/env node", "let body = ''; process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => body += chunk);",
    "process.stdin.on('end', () => console.log(JSON.stringify({ type: 'item.completed',",
    "item: { type: 'agent_message', text: body } })));",
  ].join('\n'), { mode: 0o755 });
  const previous = process.env.GRANTTAP_CODEX_BIN;
  process.env.GRANTTAP_CODEX_BIN = stub;
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_CODEX_BIN;
    else process.env.GRANTTAP_CODEX_BIN = previous;
  });
  rememberRestrictions('demo-project', {
    projectId: 'demo-project', revision: 1, scope: 'project_and_repo', source: 'phone', rules: [],
    guidance: { principles: ['behavior_tests'], architecture: 'feature_modules', markdown: '**Demo only**' },
  }, root);
  const session: SessionInfo = { sessionId: 'guidance-fixture-chat', agent: 'codex',
    projectId: 'demo-project', cwd: root, state: 'idle', startedAt: 1, lastActivityAt: 1,
    tokensSession: 0, tokensLastTurn: 0 };
  const original = 'Inspect the demo fixture without external writes.';
  const result = await deliverToSession(session, original, 5_000);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.text, /feature modules/);
  assert.match(result.text, /\*\*Demo only\*\*/);
  assert.equal(result.text.split(original).length - 1, 1);
  const unrelated = await deliverToSession({ ...session, projectId: 'other-project' }, original, 5_000);
  assert.equal(unrelated.ok, true);
  if (unrelated.ok) assert.equal(unrelated.text, original);
});

test('repository CI reports advisory guidance without claiming it was machine checked', () => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-guidance-ci-'));
  process.env.GRANTTAP_CONFIG_DIR = join(root, 'config');
  rememberRestrictions('demo-project', {
    projectId: 'demo-project', revision: 1, scope: 'project_and_repo', source: 'phone', rules: [],
    guidance: { principles: ['clear_names'], architecture: 'preserve', markdown: '' },
  }, root);
  const result = runRestrictionsCheck(root);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /advisory.*not machine.checked/i);
  assert.doesNotMatch(result.stdout, /none configured/);
});
