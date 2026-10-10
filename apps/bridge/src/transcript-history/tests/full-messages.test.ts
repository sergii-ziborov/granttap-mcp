import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTranscriptHistory } from '..';
import { codexLogPathBySession } from '../../sessions/scan/codex/shared';
import { claudeLogPathBySession } from '../../sessions/scan/claude/shared';
import type { SessionInfo } from '../../../../../packages/protocol/schema';

for (const provider of ['codex', 'claude'] as const) {
  test(`${provider}: history keeps the full visible message beyond the preview text limit`, t => {
    const root = mkdtempSync(join(tmpdir(), 'granttap-full-message-'));
    const id = `full-message-${provider}`, path = join(root, 'log.jsonl');
    t.after(() => { rmSync(root, { recursive: true, force: true });
      codexLogPathBySession.delete(id); claudeLogPathBySession.delete(id); });
    const text = 'A real paragraph.\n'.repeat(2000) + 'THE END';
    const row = provider === 'codex' ? { type: 'response_item', timestamp: new Date(1000).toISOString(),
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }
      : { type: 'assistant', uuid: 'long-answer', timestamp: new Date(1000).toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text }] } };
    writeFileSync(path, JSON.stringify(row) + '\n');
    (provider === 'codex' ? codexLogPathBySession : claudeLogPathBySession).set(id, path);
    const session: SessionInfo = { sessionId: id, agent: provider, state: 'idle', startedAt: 1,
      lastActivityAt: 1000, tokensSession: 0, tokensLastTurn: 0 };
    assert.equal(readTranscriptHistory(session)?.entries[0]?.text, text);
  });
}
