import assert from 'node:assert/strict';
import test from 'node:test';
import { CapabilityUsageStatus, type SessionInfo, type RemoteCapabilityUsageEvent } from '../../../../../../packages/protocol/schema';
import { scanCapabilityUsage, scopeCapabilityUsageToRoom } from '../../index';

test('execution evidence survives detail trimming within the complete encrypted payload budget', () => {
  const now = Date.now() - 5000;
  const events: RemoteCapabilityUsageEvent[] = Array.from({ length: 1000 }, (_, index) => ({
    agent: 'codex', sessionId: 'native-task', sourceId: `native-task:call-${index}`,
    name: `${index}-${'long-server-'.repeat(12)}`.slice(0, 160), kind: 'mcp', toolName: 'mcp__server__tool',
    createdAt: now + index, durationMs: 20, outcome: 'success',
  }));
  const status = scanCapabilityUsage([{ agent: 'codex', sessionId: 'native-task' }] as SessionInfo[],
    { scopes: ['native-task'], events, summaries: [] });
  const wire = scopeCapabilityUsageToRoom(status, 'authenticated-room');
  assert.ok(wire.executionSummaries!.length > wire.events.length);
  assert.ok(wire.executionSummaries!.length <= 128);
  assert.ok(Buffer.byteLength(JSON.stringify(wire)) <= 48 * 1024);
  assert.equal(wire.totals?.find(row => row.kind === 'mcp' && row.name == null && row.windowHours === 24)?.count, 1000);
  assert.equal(CapabilityUsageStatus.safeParse(wire).success, true);
});
