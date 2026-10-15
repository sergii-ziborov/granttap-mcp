import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { connectInMemory, textResult } from '../../../../../../tests/support/mcp-client';
import { recordAttributedCall } from '../../../../../bridge/src/mesh/identity/call-scope';
import { RoutingRequests } from '../../../../../bridge/src/task-routing/requests';
import { admitTaskOffload } from '../../../../../bridge/src/task-routing/admission';
import { registerRoutingTool } from '../index';

test('the actual MCP schema preserves hook attribution when optional resource defaults are omitted', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-offload-attribution-'));
  const previous = process.env.GRANTTAP_CONFIG_DIR, ownSession = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.GRANTTAP_CONFIG_DIR = root; process.env.CLAUDE_CODE_SESSION_ID = 'native-chat';
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = previous;
    if (ownSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = ownSession;
    rmSync(root, { recursive: true, force: true });
  });
  const store = new RoutingRequests(join(root, 'requests'));
  const server = new McpServer({ name: 'routing-fixture', version: '1' });
  registerRoutingTool(server, (args, proof) => admitTaskOffload(args, proof, { store, enabled: () => true,
    source: () => ({ sessionId: 'native-chat', provider: 'codex', projectId: 'project', taskId: 'task',
      model: 'native-model', effort: 'high' }), allowed: async () => true }));
  const client = await connectInMemory(server); t.after(() => client.close());
  const args = { operationId: 'fixture', requirements: { reason: 'capacity' } };
  const refused = await client.callTool({ name: 'offload_task', arguments: args });
  assert.equal(refused.isError, true); assert.equal(store.pending().length, 0);
  recordAttributedCall({ provider: 'codex', sessionId: 'native-chat', toolName: 'mcp__granttap__offload_task', args });
  const result = await client.callTool({ name: 'offload_task', arguments: args });
  assert.notEqual(result.isError, true, textResult(result));
  assert.equal(JSON.parse(textResult(result)).status, 'awaiting_idle');
  assert.equal(store.pending().length, 1);
});
