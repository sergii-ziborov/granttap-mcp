import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { parseCodexFile } from '../../scan/codex/parse';
import { parseClaudeFile } from '../../scan/claude/parse';

function scan(t: TestContext, text: string, title = 'Preview task') {
  const root = mkdtempSync(join(tmpdir(), 'granttap-plain-preview-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'rollout-preview.jsonl');
  const rows = [
    { type: 'session_meta', payload: { id: 'preview-task', cwd: root, title } },
    { type: 'event_msg', timestamp: '2026-11-07T20:00:00.000Z',
      payload: { type: 'agent_message', message: text } },
  ];
  writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n'));
  return parseCodexFile(file)!.session;
}

test('catalog previews remove Markdown before a link or emphasis is shortened', t => {
  const visible = 'Проверка '.repeat(14);
  const text = `## Готово\n\n${visible}[полный отчёт](https://example.test/${'long/'.repeat(70)}) **проверен**`;
  const session = scan(t, text);
  assert.equal(session.summary, `Готово ${visible}полный отчёт проверен`.slice(0, 160));
  const bold = scan(t, 'Bound '.repeat(24) + '**highlighted source text**');
  assert.equal(bold.summary, ('Bound '.repeat(24) + 'highlighted source text').slice(0, 160));
});

test('catalog previews preserve literal code punctuation and adjacent formatted words', t => {
  const session = scan(t, 'Use `src/**/*.ts` and **review** the [guide](https://example.test/guide).');
  assert.equal(session.summary, 'Use src/**/*.ts and review the guide.');
});

test('native task titles resolve Markdown before their shorter catalog limit', t => {
  const prefix = 'Name '.repeat(20);
  const title = `# ${prefix}[guide](https://example.test/${'long/'.repeat(50)}) **ready**`;
  assert.equal(scan(t, 'Status', title).title, `${prefix}guide ready`);
});

test('Claude string and block messages use the same plain catalog contract', t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-claude-preview-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [index, content] of ['## Done: **checked**', [{ type: 'text', text: '## Done: **checked**' }]].entries()) {
    const file = join(root, `preview-${index}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: 'assistant', sessionId: `preview-${index}`, cwd: root,
      timestamp: '2026-11-07T20:00:00.000Z', message: { role: 'assistant', content } }));
    assert.equal(parseClaudeFile(file)!.session.summary, 'Done: checked');
  }
});
