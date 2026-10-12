import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { desktopTaskWorkspace } from '../../workspace/task-files';
function fixture(t: test.TestContext) {
    const directory = mkdtempSync('/tmp/granttap-desktop-workspace-');
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const workspace = join(directory, 'workspace');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'actual.swift'), 'let value = 42');
    const storePath = join(directory, 'mesh.json');
    writeFileSync(storePath, JSON.stringify({ version: 1,
        projects: [{ projectId: 'p', name: 'Fixture', canonicalRepositoryId: 'repo', createdAt: 1 }],
        tasks: [{ taskId: 't', projectId: 'p', title: 'Files', goal: 'Inspect files', state: 'working', createdAt: 1, updatedAt: 2 }],
        executions: [{ taskId: 't', sessionId: 's', provider: 'codex', computerId: 'mac', workspace, startedAt: 1 }],
    }));
    return { storePath, query: { project_id: 'p', task_id: 't', session_id: 's', mode: 'directory', path: '' } };
}
test('desktop file review reads the exact recorded Task execution workspace', t => {
    const { query, storePath } = fixture(t);
    assert.equal(desktopTaskWorkspace(query, storePath)?.entries?.[0]?.path, 'actual.swift');
    assert.equal(desktopTaskWorkspace({ ...query, mode: 'file', path: 'actual.swift' }, storePath)?.text, 'let value = 42');
});
test('desktop requests cannot substitute a Project Task execution or arbitrary root', t => {
    const { query, storePath } = fixture(t);
    for (const changed of [{ project_id: 'other' }, { task_id: 'other' }, { session_id: 'other' }, { mode: 'write' },
        { path: '../mesh.json' }, { offset: -1 }, { offset: 0.5 }]) {
        assert.equal(desktopTaskWorkspace({ ...query, ...changed }, storePath), undefined);
    }
    assert.equal(desktopTaskWorkspace(null, storePath), undefined);
    assert.equal(desktopTaskWorkspace([], storePath), undefined);
    assert.equal(desktopTaskWorkspace(query, storePath + '.missing'), undefined);
});
