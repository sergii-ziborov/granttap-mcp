import assert from 'node:assert/strict';
import test from 'node:test';
import { publishEnrichedMeshes } from '../enrichment';
import type { MeshSnapshot } from '../../../../../../packages/protocol/schema';
const snapshot = (id: string): MeshSnapshot => ({ type: 'mesh.snapshot', sessionId: id, projectId: id,
    project: { projectId: id, name: 'Fixture', canonicalRepositoryId: id, createdAt: 1 },
    tasks: [], executions: [], claims: [], dependencies: [], events: [], generatedAt: 1 });
test('a ready Project reaches the phone while another binding is still restoring', async () => {
    let release!: (value: MeshSnapshot) => void;
    const held = new Promise<MeshSnapshot>(resolve => { release = resolve; });
    const sent: string[] = [];
    const job = publishEnrichedMeshes([snapshot('slow'), snapshot('ready')], async (mesh) => { sent.push(mesh.projectId); }, async (mesh) => mesh.projectId === 'slow' ? held : mesh);
    try {
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(sent, ['ready']);
    }
    finally {
        release(snapshot('slow'));
        await job;
    }
    assert.deepEqual(sent, ['ready', 'slow']);
});
test('one unavailable Project does not discard another completed report', async () => {
    const sent: string[] = [];
    await publishEnrichedMeshes([snapshot('failed'), snapshot('ready')], async (mesh) => { sent.push(mesh.projectId); }, async (mesh) => {
        if (mesh.projectId === 'failed')
            throw Error('Unavailable fixture binding');
        return mesh;
    });
    assert.deepEqual(sent, ['ready']);
});
