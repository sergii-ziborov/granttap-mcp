import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { prepareCursorContinuation } from '..';
import type { ActivityEntry, SessionInfo } from '../../../../../../packages/protocol/schema';

test('the first IDE continuation retains visible intent, then resumes durable CLI context', t => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-retained-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const session: SessionInfo = { sessionId: 'ide-chat', agent: 'cursor', cwd: '/fixture', state: 'idle',
    startedAt: 1, lastActivityAt: 2, tokensSession: 0, tokensLastTurn: 0 };
  const entries: ActivityEntry[] = [
    { id: 'request', kind: 'user', text: 'Retain the original task intent', createdAt: 1 },
    { id: 'answer', kind: 'message', text: 'Retained visible answer', createdAt: 2 },
    { id: 'tool', kind: 'tool', text: 'Tool result is excluded', createdAt: 3 },
    { id: 'child', kind: 'message', childThreadId: 'child', text: 'Child is excluded', createdAt: 4 },
  ];
  const source = { root, known: () => true, entries: () => entries };
  const first = prepareCursorContinuation(session, 'Continue', source);
  assert.equal(first.viaStdin, true);
  assert.match(first.prompt, /original task intent/); assert.match(first.prompt, /Retained visible answer/);
  assert.doesNotMatch(first.prompt, /Tool result is excluded|Child is excluded/);
  assert.equal(prepareCursorContinuation(session, 'Retry after failure', source).viaStdin, true,
    'a failed provider run never consumes the original context');
  first.complete();
  const reopened = prepareCursorContinuation(session, 'Next message', source);
  assert.equal(reopened.viaStdin, false); assert.equal(reopened.prompt, 'Next message');
  const metadata = readdirSync(root).find(name => name.endsWith('.json'))!;
  assert.doesNotMatch(readFileSync(join(root, metadata), 'utf8'), /task intent|visible answer/);
  assert.equal(prepareCursorContinuation({ ...session, cwd: '/another-workspace' }, 'Continue', source).viaStdin, true);
  assert.equal(prepareCursorContinuation({ ...session, sessionId: 'native-cli' }, 'Continue',
    { ...source, known: () => false }).viaStdin, false);
  assert.throws(() => prepareCursorContinuation({ ...session, sessionId: 'empty' }, 'Continue',
    { ...source, entries: () => [] }), /could not be restored/);
});
