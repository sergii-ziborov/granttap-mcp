import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProjectPolicySet, ProjectPolicyStatus, type ProjectPolicyPayload } from '../../../../../../../packages/protocol/schema';
import { applyPolicy } from '../../../../project-policy/apply';
import type { ProjectPolicyRuntimeDependencies } from '../../../../project-policy/types';
import { loadRestrictions } from '../../index';

test('the canonical policy status confirms exact persisted guidance with its applied revision', async () => {
  process.env.GRANTTAP_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'granttap-guidance-policy-'));
  const request = ProjectPolicySet.parse({ type: 'project.policy.set', sessionId: 'demo', projectId: 'demo',
    expectedRevision: 0, createdAt: 1, policy: {
      projectId: 'demo', revision: 1, enforcement: 'best_available', rules: [],
      restrictions: { projectId: 'demo', revision: 1, scope: 'project', source: 'phone', rules: [],
        guidance: { principles: ['behavior_tests'], architecture: 'hexagonal', markdown: '# Exact\n\n**Kept**\n' } },
    } });
  const sent: ProjectPolicyPayload[] = [];
  const deps: ProjectPolicyRuntimeDependencies = {
    endpointId: () => 'fixture-mac', providers: () => [], now: () => 2,
    send: async (_relay, payload) => { sent.push(payload); },
    client: { async request(operation) {
      if (operation.operation === 'policy.apply') return { operation: 'policy.applied', policy: operation.input.policy };
      if (operation.operation === 'policy.coverage') return { operation: 'policy.coverage', coverage: {
        project_id: 'demo', policy_revision: 1, enforcement: 'best_available', required_capabilities: [],
        endpoints: [], strict_ready: true,
      } };
      throw new Error(`Unexpected fixture operation: ${operation.operation}`);
    } },
  };
  assert.equal(await applyPolicy(deps, undefined, request), true);
  const status = ProjectPolicyStatus.parse(sent.at(-1));
  assert.equal(status.policy.revision, 1);
  assert.deepEqual(status.policy.restrictions, request.policy.restrictions);
  assert.deepEqual(loadRestrictions('demo'), status.policy.restrictions);
});
