import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { scanClaude } from '../..';
import { scanCapabilityUsage } from '../../../..';

test('Claude preserves MCP and skill counts after newer CLI calls evict their details', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-claude-recorded-'));
  const project = join(root, 'project');
  mkdirSync(project);
  const previous = process.env.GRANTTAP_CLAUDE_PROJECTS_DIR;
  process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_CLAUDE_PROJECTS_DIR;
    else process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const sessionId = 'recorded-claude', started = Date.now() - 100_000;
  function rows(count: number, name: string, offset = 0) {
    return Array.from({ length: count }, (_, index) => {
      const id = `${offset}-${index}`, at = started + offset + index * 20;
      return [
        { type: 'assistant', sessionId, timestamp: new Date(at).toISOString(),
          message: { role: 'assistant', content: [{ type: 'tool_use', id, name,
            input: name === 'Skill' ? { skill: 'review-workflow' } : { command: 'PRIVATE_ARGUMENT' } }] } },
        { type: 'user', sessionId, timestamp: new Date(at + 5).toISOString(),
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id,
            content: 'PRIVATE_RESULT', is_error: name.startsWith('mcp__') && index === 0 }] } },
      ];
    }).flat();
  }
  function write(path: string, entries: unknown[]) {
    writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  }
  write(join(project, sessionId + '.jsonl'), [
    ...rows(1, 'Skill'), ...rows(350, 'mcp__granttap__inspect', 100),
    ...rows(300, 'Bash', 20_000),
  ]);
  const children = join(project, sessionId, 'subagents');
  mkdirSync(children, { recursive: true });
  write(join(children, 'agent-child.jsonl'), rows(5, 'mcp__granttap__inspect', 10_000));
  for (let pass = 0; pass < 2; pass++) {
    const sessions = scanClaude().sessions;
    assert.equal(sessions.length, 1);
    const status = scanCapabilityUsage(sessions);
    const mcp = status.executionSummaries?.find(row => row.kind === 'mcp' && row.name === 'granttap');
    assert.equal(mcp?.count, 355);
    assert.equal(mcp.failures, 2);
    assert.equal(mcp.durationCount, 355);
    assert.equal(mcp.durationMs, 1775);
    assert.equal(status.executionSummaries?.find(row => row.kind === 'skill')?.count, 1);
    assert.equal(status.totals?.find(row => row.kind === 'mcp' && row.name === 'granttap' && row.windowHours === 24)?.count, 355);
    assert.ok(!JSON.stringify(status.executionSummaries).includes('PRIVATE_'));
    assert.ok(Buffer.byteLength(JSON.stringify(status)) <= 48 * 1024);
  }
});
