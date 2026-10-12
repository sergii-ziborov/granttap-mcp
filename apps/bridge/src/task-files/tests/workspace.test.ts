import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readTaskWorkspace } from '..';
import type { SessionInfo } from '../../../../../packages/protocol/schema';
function fixture(t: test.TestContext) {
    const root = mkdtempSync('/tmp/granttap-task-files-');
    mkdirSync(join(root, 'workspace', 'src'), { recursive: true });
    writeFileSync(join(root, 'workspace', 'src', 'app.swift'), 'let value = 42\n');
    writeFileSync(join(root, 'workspace', '.env'), 'API_KEY=fixture-secret');
    writeFileSync(join(root, 'private.txt'), 'Outside this execution');
    symlinkSync(join(root, 'private.txt'), join(root, 'workspace', 'external.txt'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return { root, session: { sessionId: 'dedicated-file-review', agent: 'codex', state: 'idle', startedAt: 1,
            lastActivityAt: 2, tokensSession: 0, tokensLastTurn: 0, cwd: join(root, 'workspace') } as SessionInfo };
}
test('files are grouped by directory and code is read from the task workspace', t => {
    const { session } = fixture(t);
    const directory = readTaskWorkspace(session, { mode: 'directory', path: '' });
    assert.deepEqual(directory?.entries?.map(e => [e.name, e.kind]), [['src', 'directory']]);
    assert.equal(readTaskWorkspace(session, { mode: 'file', path: 'src/app.swift' })?.text, 'let value = 42\n');
    assert.equal(readTaskWorkspace(session, { mode: 'file', path: 'src/app.swift' })?.truncated, false);
});
test('workspace traversal, external symlinks, credentials and absent native roots are refused', t => {
    const { session, root } = fixture(t);
    for (const path of ['../private.txt', join(root, 'private.txt'), 'external.txt', '.env', 'src/../../private.txt']) {
        assert.equal(readTaskWorkspace(session, { mode: 'file', path }), undefined, path);
    }
    assert.equal(readTaskWorkspace({ ...session, cwd: undefined }, { mode: 'directory', path: '' }), undefined);
});
test('large files and directory pages remain bounded without hiding that they are partial', t => {
    const { session } = fixture(t);
    const root = session.cwd!;
    writeFileSync(join(root, 'large.swift'), 'a'.repeat(200000));
    const file = readTaskWorkspace(session, { mode: 'file', path: 'large.swift' });
    assert.ok(file?.truncated);
    assert.ok((file?.text?.length ?? 0) <= 128 * 1024);
    for (let i = 0; i < 260; i++)
        writeFileSync(join(root, `file-${i}.swift`), '');
    const first = readTaskWorkspace(session, { mode: 'directory', path: '' });
    assert.equal(first?.entries?.length, 200);
    assert.equal(first?.nextOffset, 200);
    const second = readTaskWorkspace(session, { mode: 'directory', path: '', offset: 200 });
    assert.equal(second?.entries?.length, 62);
    assert.equal(second?.truncated, false);
});
test('bounded UTF8 previews retain whole characters and refuse binary or credential aliases', t => {
    const { session } = fixture(t), root = session.cwd!;
    writeFileSync(join(root, 'unicode.swift'), 'x'.repeat(128 * 1024 - 1) + '😀'.repeat(10));
    const preview = readTaskWorkspace(session, { mode: 'file', path: 'unicode.swift' });
    assert.equal(preview?.text, 'x'.repeat(128 * 1024 - 1));
    assert.equal(preview?.truncated, true);
    assert.equal(preview?.nextOffset, 128 * 1024 - 1);
    const remainder = readTaskWorkspace(session, { mode: 'file', path: 'unicode.swift', offset: 128 * 1024 - 1 });
    assert.equal(remainder?.text, '😀'.repeat(10));
    assert.equal(remainder?.truncated, false);
    writeFileSync(join(root, 'binary'), Buffer.from([255, 0, 1]));
    symlinkSync(join(root, '.env'), join(root, 'alias.txt'));
    assert.equal(readTaskWorkspace(session, { mode: 'file', path: 'binary' }), undefined);
    assert.equal(readTaskWorkspace(session, { mode: 'file', path: 'alias.txt' }), undefined);
});
