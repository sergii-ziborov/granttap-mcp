import assert from 'node:assert/strict';
import test from 'node:test';
import { fitRepositoryGraph } from '../fit';
import { ProjectRepositoryGraph } from '../../../../../../../packages/protocol/schema';

function denseRepository() {
  const files = Array.from({ length: 73 }, (_, index) => ({
    path: `crates/portable-core/src/module-${index}.rs`, language: 'rust', lineCount: 253,
    symbols: Array.from({ length: 3 }, (_, section) => ({
      id: `module-${index}#section-${section}`, label: `section_${section}`, kind: 'function',
      startLine: section * 70 + 1, lineCount: 60,
    })),
  }));
  const roads = Array.from({ length: 1199 }, (_, index) => ({
    source: files[Math.floor(index / 72)]!.path,
    target: files[(Math.floor(index / 72) + index % 72 + 1) % files.length]!.path,
    relation: 'imports',
  }));
  roads.push({ source: files.at(-1)!.path, target: 'ext:store', relation: 'consumes' });
  return ProjectRepositoryGraph.parse({
    projectId: 'portable-project', repositoryId: 'portable-repository', revision: 'observed-content',
    weavatrixVersion: '2.17.4', analysisStatus: 'COMPLETE', nodes: [], relations: [],
    totalNodes: 0, totalRelations: 0, truncated: false,
    codeMap: { files, roads, externals: [{ id: 'ext:store', label: 'Store', kind: 'service' }],
      totalFiles: files.length, totalExternals: 1, truncated: false },
  });
}

test('a dense road inventory does not erase measured source sections to fit the relay', () => {
  const graph = denseRepository();
  const budget = Buffer.byteLength(JSON.stringify(graph)) - 10_000;
  const fitted = fitRepositoryGraph(graph, budget);
  assert.ok(fitted?.codeMap);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= budget);
  assert.equal(ProjectRepositoryGraph.safeParse(fitted).success, true);
  assert.deepEqual(fitted.codeMap.files, graph.codeMap!.files,
    'Every received file and measured section survives when a bounded relation sample makes it fit');
  assert.equal(fitted.codeMap.truncated, true);
  assert.ok(fitted.codeMap.roads.length < graph.codeMap!.roads.length);
  const observed = new Set(graph.codeMap!.roads.map(road => JSON.stringify(road)));
  for (const road of fitted.codeMap.roads) assert.ok(observed.has(JSON.stringify(road)));
  const endpoints = new Set(fitted.codeMap.roads.flatMap(road => [road.source, road.target]));
  for (const file of graph.codeMap!.files) assert.ok(endpoints.has(file.path));
  assert.ok(endpoints.has('ext:store'), 'A late external-service link must remain inspectable');
  assert.equal(graph.codeMap!.truncated, false, 'Wire fitting must not mutate the engine report');
});
