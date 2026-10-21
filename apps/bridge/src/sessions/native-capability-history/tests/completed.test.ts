import assert from 'node:assert/strict';
import test from 'node:test';
import { codexCapabilityUsage } from '../../scan/codex/activity';
import type { SessionInfo } from '../../../../../../packages/protocol/schema';

const session = { sessionId: 'native-task', agent: 'codex', lastActivityAt: 1000 } as SessionInfo;
const completed = (changes = {}) => JSON.stringify({ type: 'event_msg', timestamp: 1000,
  payload: { type: 'item_completed', thread_id: 'native-task', started_at_ms: 1000,
    completed_at_ms: 1400, item: { type: 'McpToolCall', id: 'call-1', server: 'code-review',
      tool: 'review', status: 'completed', duration: { secs: 0, nanos: 320000000 },
      result: { isError: true }, ...changes } } });

test('native completed MCP calls expose their own result and measured duration', () => {
  const rows = codexCapabilityUsage(session, [completed()]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.mcpServer, 'code-review');
  assert.equal(rows[0]?.durationMs, 320);
  assert.equal(rows[0]?.outcome, 'error');
});

test('separate MCP namespaces and completed records refer to one actual invocation', () => {
  const call = JSON.stringify({ type: 'response_item', timestamp: 1000,
    payload: { type: 'function_call', name: 'review', namespace: 'mcp__code-review', call_id: 'call-1', arguments: '{}' } });
  const rows = codexCapabilityUsage(session, [call, completed()]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.sourceId, 'native-task:call-1');
});
