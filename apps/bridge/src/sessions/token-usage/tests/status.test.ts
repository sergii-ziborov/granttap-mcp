import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CapabilityUsageStatus } from '../../../../../../packages/protocol/schema';
import { scanCapabilityUsage, scopeCapabilityUsageToRoom } from '../..';
import { parseClaudeFile } from '../../scan/claude/parse';
import { claudeLogPathBySession, claudeSummaryCache } from '../../scan/claude/shared';
import { MAX_CAPABILITY_USAGE_PAYLOAD_BYTES } from '../../telemetry';

const SESSION = 'c0000000-0000-4000-8000-0000000000bb';

test('the usage status publishes what each period spent, from the readers\' caches, within the wire budget', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-token-status-'));
  const file = join(root, `${SESSION}.jsonl`);
  t.after(() => { claudeSummaryCache.delete(file); claudeLogPathBySession.delete(SESSION); rmSync(root, { recursive: true, force: true }); });
  const at = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(file, [
    { type: 'user', sessionId: SESSION, cwd: '/fixture', timestamp: at, message: { role: 'user', content: 'Synthetic question' } },
    { type: 'assistant', sessionId: SESSION, timestamp: at, message: { role: 'assistant', model: 'claude-opus-5-5',
      content: [{ type: 'text', text: 'Synthetic answer' }], usage: { input_tokens: 1_200, output_tokens: 34 } } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  const session = parseClaudeFile(file)!.session;
  claudeLogPathBySession.set(SESSION, file);
  const status = scopeCapabilityUsageToRoom(scanCapabilityUsage([session, { ...session }]), 'room');
  assert.equal(CapabilityUsageStatus.safeParse(status).success, true);
  assert.ok(Buffer.byteLength(JSON.stringify(status)) <= MAX_CAPABILITY_USAGE_PAYLOAD_BYTES);
  const day = status.tokenUsage!.windows.find((row) => row.windowHours === 24)!;
  assert.equal(day.tokens, 1_234, 'a chat listed twice counts once');
  assert.deepEqual(day.chats, [{ sessionId: SESSION, agent: 'claude', model: 'claude-opus-5-5', tokens: 1_234 }]);
  assert.deepEqual(day.models, [{ agent: 'claude', model: 'claude-opus-5-5', tokens: 1_234 }]);
  assert.equal(status.tokenUsage!.hours.reduce((sum, hour) => sum + hour.tokens, 0), 1_234);
});
