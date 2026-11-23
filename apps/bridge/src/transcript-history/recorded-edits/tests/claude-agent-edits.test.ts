import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTranscriptHistory } from '../../index';
import { claudeChildLogPathsBySession, claudeLogPathBySession } from '../../../sessions/scan/claude/shared';
import type { ActivityEntry, SessionInfo } from '../../../../../../packages/protocol/schema';

const at = (i: number) => new Date(1_800_000_000_000 + i * 1000).toISOString();
const rows = (items: unknown[]) => items.map(item => JSON.stringify(item)).join('\n') + '\n';
const said = (i: number, role: 'user' | 'assistant', text: string, agentId?: string) => ({ type: role, uuid: `${agentId ?? 'root'}-${i}`,
  timestamp: at(i), ...(agentId ? { agentId, isSidechain: true } : {}), message: { role, content: text } });
const call = (i: number, id: string, name: string, input: unknown, agentId?: string) => ({ type: 'assistant',
  uuid: `${agentId ?? 'root'}-${i}`, timestamp: at(i), ...(agentId ? { agentId, isSidechain: true } : {}),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (i: number, id: string, extra: { error?: boolean; toolUseResult?: unknown; agentId?: string } = {}) => ({
  type: 'user', uuid: `${extra.agentId ?? 'root'}-${i}`, timestamp: at(i),
  ...(extra.agentId ? { agentId: extra.agentId, isSidechain: true } : {}),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...(extra.error ? { is_error: true } : {}) }] },
  ...(extra.toolUseResult ? { toolUseResult: extra.toolUseResult } : {}) });

const launchOf = (entries: ActivityEntry[], description: string) =>
  entries.find(entry => ['Agent', 'Task'].includes(entry.toolName ?? '') && entry.summary === description)!;

/** The chat's Files list as the phone builds it: every root entry's recorded edits, one row per path. */
function filesList(entries: ActivityEntry[]) {
  const byPath = new Map<string, { added: number; agent?: string; folder?: string }>();
  for (const entry of entries.filter(item => !item.childThreadId)) {
    for (const file of entry.fileChanges ?? []) {
      const previous = byPath.get(file.path);
      byPath.set(file.path, { added: (previous?.added ?? 0) + file.linesAdded,
        agent: previous?.agent ?? file.agentTitle, folder: previous?.folder ?? file.folder });
    }
  }
  return [...byPath].sort(([a], [b]) => a.localeCompare(b));
}

function fixture(t: { after: (fn: () => void) => void }, sessionId: string) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-agent-files-'));
  const chat = join(root, 'chat-repo'), worktree = join(root, 'other-worktree'), scratch = join(root, 'scratch');
  mkdirSync(join(chat, '.git'), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, '.git'), 'gitdir: elsewhere\n');
  mkdirSync(scratch, { recursive: true });
  const subagents = join(root, 'projects', sessionId, 'subagents');
  mkdirSync(subagents, { recursive: true });
  const main = join(root, 'projects', `${sessionId}.jsonl`);
  const session: SessionInfo = { sessionId, agent: 'claude', state: 'idle', cwd: chat, startedAt: 1,
    lastActivityAt: 2e12, tokensSession: 0, tokensLastTurn: 0 };
  claudeLogPathBySession.set(sessionId, main);
  t.after(() => {
    claudeLogPathBySession.delete(sessionId); claudeChildLogPathsBySession.delete(sessionId);
    rmSync(root, { recursive: true, force: true });
  });
  const agent = (id: string, items: unknown[], meta?: unknown) => {
    const path = join(subagents, `agent-${id}.jsonl`);
    writeFileSync(path, rows(items));
    if (meta) writeFileSync(join(subagents, `agent-${id}.meta.json`), JSON.stringify(meta));
    claudeChildLogPathsBySession.set(sessionId, [...claudeChildLogPathsBySession.get(sessionId) ?? [], path]);
    return path;
  };
  return { chat, worktree, scratch, removed: join(root, 'removed-worktree'), main, session, agent };
}

test('a chat lists the files its agents changed in other checkouts, each marked with its agent', t => {
  const { chat, worktree, scratch, removed, main, session, agent } = fixture(t, 'agents-two-folders');
  writeFileSync(main, rows([
    said(0, 'user', 'Fix the limit tests'),
    call(1, 'main-edit', 'Edit', { file_path: join(chat, 'src/main.ts'), old_string: 'a', new_string: 'b' }),
    result(2, 'main-edit', { toolUseResult: { filePath: join(chat, 'src/main.ts'), structuredPatch: [{ lines: ['-a', '+b'] }] } }),
    call(3, 'launch', 'Agent', { description: 'Fix limit tests', prompt: 'Fix them', subagent_type: 'general-purpose' }),
    result(4, 'launch', { toolUseResult: { agentId: 'a1', status: 'completed' } }),
    call(5, 'launch-meta', 'Agent', { description: 'Write the notes', prompt: 'Notes' }),
    result(6, 'launch-meta'),
    said(7, 'assistant', 'Done'),
  ]));
  const test = join(worktree, 'src/limit-continuation.test.ts');
  agent('a1', [
    said(1, 'user', 'Fix them', 'a1'),
    call(2, 'e1', 'Edit', { file_path: test, old_string: 'old', new_string: 'new\nmore' }, 'a1'),
    result(3, 'e1', { agentId: 'a1', toolUseResult: { filePath: test, structuredPatch: [{ lines: [' keep', '-old', '+new', '+more'] }] } }),
    call(4, 'e2', 'Edit', { file_path: join(chat, 'src/shared.ts'), old_string: 'x', new_string: 'y' }, 'a1'),
    result(5, 'e2', { agentId: 'a1' }),
    call(6, 'e3', 'Edit', { file_path: join(worktree, 'src/fail.ts'), old_string: 'x', new_string: 'y' }, 'a1'),
    result(7, 'e3', { agentId: 'a1', error: true }),
    call(8, 'e4', 'Write', { file_path: join(worktree, '.env'), content: 'TOKEN=1' }, 'a1'),
    result(9, 'e4', { agentId: 'a1' }),
    call(10, 'e5', 'Edit', { file_path: test, old_string: 'z', new_string: 'w' }, 'a1'),
    result(11, 'e5', { agentId: 'a1' }),
    call(17, 'gone', 'Edit', { file_path: join(removed, 'apps/src/limit/tests/gone.test.ts'), old_string: 'q', new_string: 'r' }, 'a1'),
    result(18, 'gone', { agentId: 'a1' }),
    call(12, 'nested', 'Agent', { description: 'Check the scratch probe', prompt: 'Probe' }, 'a1'),
    result(13, 'nested', { agentId: 'a1', toolUseResult: { agentId: 'a2' } }),
  ]);
  agent('a2', [said(14, 'user', 'Probe', 'a2'),
    call(15, 'p1', 'Write', { file_path: join(scratch, 'probe.ts'), content: 'one\ntwo\n' }, 'a2'),
    result(16, 'p1', { agentId: 'a2', toolUseResult: { type: 'create', filePath: join(scratch, 'probe.ts'), structuredPatch: [] } })]);
  agent('a3', [said(1, 'user', 'Notes', 'a3'),
    call(2, 'n1', 'Write', { file_path: join(worktree, 'docs/notes.md'), content: 'notes\n' }, 'a3'),
    result(3, 'n1', { agentId: 'a3' })], { toolUseId: 'launch-meta', description: 'Write the notes' });
  agent('a4', [call(1, 'u1', 'Write', { file_path: join(scratch, 'unrelated.ts'), content: 'x' }, 'a4'),
    result(2, 'u1', { agentId: 'a4' })], { toolUseId: 'another-chat-call' });

  const page = readTranscriptHistory(session)!;
  const own = page.entries.find(entry => entry.toolName === 'Edit')!;
  assert.deepEqual(own.fileChanges, [{ path: join(chat, 'src/main.ts'), linesAdded: 1, linesRemoved: 1, diff: '-a\n+b',
    diffTruncated: false, folder: chat }]);
  const launch = launchOf(page.entries, 'Fix limit tests');
  assert.deepEqual(launch.fileChanges?.map(file => [file.path, file.agentThreadId, file.agentTitle]), [
    [join(chat, 'src/shared.ts'), 'a1', 'Fix limit tests'],
    [test, 'a1', 'Fix limit tests'],
    [join(removed, 'apps/src/limit/tests/gone.test.ts'), 'a1', 'Fix limit tests'],
    [join(scratch, 'probe.ts'), 'a2', 'Check the scratch probe'],
  ]);
  // A worktree removed since is still one group, not one per subfolder.
  assert.equal(launch.fileChanges![2]!.folder, removed);
  const edited = launch.fileChanges!.find(file => file.path === test)!;
  assert.deepEqual([edited.linesAdded, edited.linesRemoved, edited.folder], [3, 2, worktree]);
  assert.equal(edited.diff, ' keep\n-old\n+new\n+more\n-z\n+w');
  assert.deepEqual(filesList(page.entries), [
    [join(chat, 'src/main.ts'), { added: 1, agent: undefined, folder: chat }],
    [join(chat, 'src/shared.ts'), { added: 1, agent: 'Fix limit tests', folder: chat }],
    [join(removed, 'apps/src/limit/tests/gone.test.ts'), { added: 1, agent: 'Fix limit tests', folder: removed }],
    [join(scratch, 'probe.ts'), { added: 2, agent: 'Check the scratch probe', folder: scratch }],
    [test, { added: 3, agent: 'Fix limit tests', folder: worktree }],
    [join(worktree, 'docs/notes.md'), { added: 1, agent: 'Write the notes', folder: worktree }],
  ].sort(([a], [b]) => String(a).localeCompare(String(b))));
  assert.doesNotMatch(JSON.stringify(page), /fail\.ts|\.env|TOKEN|unrelated/);
});

function bigAgent(t: { after: (fn: () => void) => void }, sessionId: string, content: string) {
  const { worktree, main, session, agent } = fixture(t, sessionId);
  writeFileSync(main, rows([said(0, 'user', 'Refactor'),
    call(1, 'launch', 'Task', { description: 'Refactor everything', prompt: 'Go' }),
    result(2, 'launch', { toolUseResult: { agentId: 'big' } })]));
  const edits = Array.from({ length: 70 }, (_, i) => [
    call(10 + i * 2, `w${i}`, 'Write', { file_path: join(worktree, `file-${String(i).padStart(2, '0')}.ts`), content }, 'big'),
    result(11 + i * 2, `w${i}`, { agentId: 'big' })]).flat();
  const path = agent('big', [said(3, 'user', 'Go', 'big'), ...edits.slice(0, 2)]);
  const launch = () => launchOf(readTranscriptHistory(session)!.entries, 'Refactor everything');
  return { session, launch, append: () => appendFileSync(path, rows(edits.slice(2))) };
}

test('an agent still working adds the edits it appends, up to 64 files marked partial', t => {
  const { launch, append } = bigAgent(t, 'agents-growing', 'x\n');
  assert.equal(launch().fileChanges?.length, 1);
  assert.equal(launch().fileChangesComplete, undefined);
  append();
  assert.equal(launch().fileChanges?.length, 64);
  assert.equal(launch().fileChangesComplete, false);
  assert.ok(launch().fileChanges!.every(file => file.agentTitle === 'Refactor everything' && file.agentThreadId === 'big'));
});

test('large agent diffs stay within the row and page byte budgets of the Files answer', t => {
  const { session, launch, append } = bigAgent(t, 'agents-large', 'x\n'.repeat(3000));
  append();
  const files = launch().fileChanges!;
  assert.ok(files.length > 0 && files.length < 64);
  assert.equal(launch().fileChangesComplete, false);
  assert.ok(files.every(file => file.diff.length <= 2048 && file.diffTruncated));
  assert.ok(Buffer.byteLength(JSON.stringify(files)) <= 128 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(readTranscriptHistory(session))) <= 384 * 1024);
});

test('agents that are gone, unlinked or unreadable add no files', t => {
  const { chat, main, session, agent } = fixture(t, 'agents-none');
  writeFileSync(main, rows([said(0, 'user', 'Hi'), said(1, 'assistant', 'Hello')]));
  assert.ok(readTranscriptHistory(session)!.entries.every(entry => !entry.fileChanges));
  const broken = agent('broken', [call(1, 'g', 'Write', { file_path: join(chat, 'a.ts'), content: 'x' }, 'broken'),
    result(2, 'g', { agentId: 'broken' })]);
  writeFileSync(broken.replace(/\.jsonl$/, '.meta.json'), '{not json');
  claudeChildLogPathsBySession.set(session.sessionId, [broken, join(chat, 'agent-missing.jsonl')]);
  writeFileSync(main, rows([said(0, 'user', 'Hi'),
    call(1, 'launch', 'Agent', { prompt: 'x' }), result(2, 'launch', { toolUseResult: { agentId: 'missing' } }),
    call(3, 'launch2', 'Agent', { prompt: 'y' }), result(4, 'launch2'),
    call(5, 'edit', 'Edit', { file_path: 'relative.ts', old_string: 'a', new_string: 'b' }), result(6, 'edit')]));
  const entries = readTranscriptHistory(session)!.entries;
  assert.ok(entries.filter(entry => entry.toolName === 'Agent').every(entry => !entry.fileChanges));
  assert.deepEqual(entries.find(entry => entry.toolName === 'Edit')?.fileChanges?.map(file => [file.path, file.folder]),
    [['relative.ts', undefined]]);
});
