import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProjectRestrictionSet, SessionInfo } from '../../../../../../../packages/protocol/schema';
import { loadRestrictions, rememberRestrictions, readRepoRestrictions, repoRestrictionsPath,
  restrictionSummary, evaluateContent } from '../../index';
import { routingPrompt } from '../../../../reply/payload/routing';

const guidance: NonNullable<ProjectRestrictionSet["guidance"]> = {
  principles: ['single_responsibility', 'behavior_tests'],
  architecture: 'hexagonal',
  classLineTarget: 100,
  parameterTarget: 4,
  markdown: '## Project conventions\n\n- **Keep** public boundaries.\n- `Do not rewrite` existing modules.\n',
};
const restrictions = {
  projectId: 'guide-project', revision: 2, scope: 'project_and_repo' as const,
  rules: [], source: 'phone' as const, guidance,
};
function isolate(): string {
  const root = mkdtempSync(join(tmpdir(), 'granttap-guidance-'));
  process.env.GRANTTAP_CONFIG_DIR = join(root, 'private');
  return root;
}

test('guidance is a bounded optional wire contract, with exact Markdown roundtrip', () => {
  const parsed = ProjectRestrictionSet.safeParse(restrictions);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.data)), restrictions);
  for (const invalid of [
    { ...guidance, architecture: 'made-up' },
    { ...guidance, principles: ['made-up'] },
    { ...guidance, principles: ['behavior_tests', 'behavior_tests'] },
    { ...guidance, markdown: 'bad\u0000text' },
    { ...guidance, markdown: 'Я'.repeat(6_001) },
    { ...guidance, parameterTarget: 0 },
    { ...guidance, classLineTarget: 1_000_001 },
  ]) assert.equal(ProjectRestrictionSet.safeParse({ ...restrictions, guidance: invalid }).success, false);
  const { guidance: _unused, ...legacy } = restrictions;
  assert.equal(ProjectRestrictionSet.safeParse(legacy).success, true);
});

test('private durable policy and repository export/import preserve all guidance', () => {
  const root = isolate();
  rememberRestrictions(restrictions.projectId, restrictions, root);
  assert.deepEqual(loadRestrictions(restrictions.projectId), restrictions);
  assert.deepEqual(readRepoRestrictions(root, restrictions.projectId), { ...restrictions, repositoryId: undefined, source: 'repo' });
  assert.deepEqual(JSON.parse(readFileSync(repoRestrictionsPath(root), 'utf8')).guidance, guidance);
  rememberRestrictions(restrictions.projectId, { ...restrictions, scope: 'sync_from_repo' }, root);
  assert.deepEqual(loadRestrictions(restrictions.projectId)?.guidance, guidance);
  assert.match(restrictionSummary(restrictions), /guidance/i);
});

test('only the matching Project turn receives advisory instructions without losing the message', () => {
  isolate();
  rememberRestrictions(restrictions.projectId, { ...restrictions, scope: 'project' });
  const session = SessionInfo.parse({ sessionId: 'test-chat', agent: 'codex', cwd: '/tmp/demo',
    title: 'Demo', state: 'idle', startedAt: 1, lastActivityAt: 1, tokensSession: 0, tokensLastTurn: 0, projectId: restrictions.projectId });
  const original = 'Please inspect the test fixture.';
  const prompt = routingPrompt(session, original, {});
  assert.match(prompt, /hexagonal/i);
  assert.match(prompt, /100/);
  assert.match(prompt, /4/);
  assert.match(prompt, /behavior/i);
  assert.ok(prompt.includes(guidance.markdown));
  assert.ok(prompt.endsWith(original));
  assert.match(prompt, /advisory/i);
  assert.equal(routingPrompt({ ...session, projectId: 'unrelated' }, original, {}), original);
  assert.equal(routingPrompt({ ...session, projectId: undefined }, original, {}), original);
  assert.equal(routingPrompt(session, original, {}), prompt);
});

test('Ruby function extents that the checker cannot measure require review', () => {
  const result = evaluateContent([{ ruleId: 'functions', kind: 'max_function_lines',
    limit: 5, effect: 'deny' }], 'src/demo.rb', 'def work\n' + '  perform\n'.repeat(12) + 'end\n');
  assert.equal(result?.effect, 'ask');
  assert.match(result?.reason ?? '', /parser review/);
});


test('empty guidance is a no-op, architecture choices and optional targets remain advisory', () => {
  isolate();
  const empty = { principles: [], architecture: 'preserve' as const, markdown: '' };
  for (const architecture of ['preserve', 'feature_modules', 'layered', 'clean', 'hexagonal', 'modular_monolith', 'mvvm'] as const) {
    const value = { ...restrictions, scope: 'project' as const, guidance: { ...empty, architecture } };
    rememberRestrictions(restrictions.projectId, value);
    const session = SessionInfo.parse({ sessionId: 'test', agent: 'claude', projectId: restrictions.projectId,
      state: 'idle', startedAt: 1, lastActivityAt: 1, tokensSession: 0, tokensLastTurn: 0 });
    const prompt = routingPrompt(session, 'original request', {});
    if (architecture === 'preserve') assert.equal(prompt, 'original request');
    else { assert.match(prompt, /advisory/); assert.ok(prompt.endsWith('original request')); }
  }
  for (const target of [{ classLineTarget: 80 }, { parameterTarget: 3 }, { markdown: 'specific instruction' }]) {
    const parsed = ProjectRestrictionSet.parse({ ...restrictions, guidance: { ...empty, ...target } });
    rememberRestrictions(restrictions.projectId, { ...parsed, scope: 'project' });
    assert.match(restrictionSummary(parsed), /guidance/);
  }
});
