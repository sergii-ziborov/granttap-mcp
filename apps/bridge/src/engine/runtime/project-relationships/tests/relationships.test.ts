import assert from "node:assert/strict";
import test from "node:test";
import { parseEngineResponse } from "../../../protocol/engine-protocol";
const graph = () => ({ project_id: "project", weavatrix_version: "2.17.5", analysis_status: "COMPLETE",
    repositories: [{ repository_id: "api", revision: "rev-api" }, { repository_id: "client", revision: "rev-client" }],
    matches: [{ source: "client", target: "api", transport: "http", relation: "contract_match", evidence_count: 1,
            evidence: [{ repository_id: "client", path: "src/client.ts", line: 12 }] }], truncated: false });
function parse(value: unknown) {
    return parseEngineResponse({ protocol_version: 1, request_id: "links", status: "ok",
        result: { operation: "graph.project_relationships", graph: value } }, "links");
}
test("Engine accepts bounded static relationship evidence without treating it as a Backbone", () => {
    const result = parse(graph());
    assert.equal(result.operation, "graph.project_relationships");
    assert.deepEqual((result as {
        graph: unknown;
    }).graph, graph());
});
test("foreign repository, unsafe file, invented dependency and inflated counts are rejected", () => {
    for (const mutate of [
        (v: ReturnType<typeof graph>) => { v.matches[0]!.target = "foreign"; },
        (v: ReturnType<typeof graph>) => { v.matches[0]!.evidence[0]!.path = "/Users/private/token"; },
        (v: ReturnType<typeof graph>) => { v.matches[0]!.evidence[0]!.path = "../outside"; },
        (v: ReturnType<typeof graph>) => { v.matches[0]!.relation = "depends_on"; },
        (v: ReturnType<typeof graph>) => { v.matches[0]!.evidence_count = -1; },
        (v: ReturnType<typeof graph>) => { v.repositories.push(v.repositories[0]!); },
    ]) {
        const value = graph();
        mutate(value);
        assert.throws(() => parse(value));
    }
});
import { projectRelationshipPeers } from "..";
import type { ProjectBindingSummary } from "../../../../../../../packages/protocol/schema";
import type { EngineClientLike } from "../../engine-supervisor";
const bindings = (): ProjectBindingSummary[] => ["api", "client"].map(repositoryId => ({
    bindingId: `binding-${repositoryId}`, projectId: "project", repositoryId, endpointId: "mac",
    displayName: repositoryId, revision: "head", available: true,
}));
test("explicit refresh shows static shared contracts; background reads never start a scan", async () => {
    let calls = 0;
    const client: EngineClientLike = { close() { }, async request(operation) {
            calls++;
            assert.equal(operation.operation, "graph.analyze_project");
            return parse(graph());
        } };
    const options = { client, env: { GRANTTAP_ENGINE_ENABLED: "1" } };
    assert.deepEqual(await projectRelationshipPeers("project", bindings(), { ...options, background: true }), []);
    assert.equal(calls, 0);
    const peers = await projectRelationshipPeers("project", bindings(), options);
    assert.equal(calls, 1);
    assert.equal(peers[0]?.relation, "shares");
    assert.equal(peers[0]?.peer, "api");
    assert.match(peers[0]?.through ?? "", /static HTTP contract; runtime target unverified/);
    assert.deepEqual(await projectRelationshipPeers("project", bindings(), { ...options, background: true }), peers);
    assert.equal(calls, 1);
    assert.deepEqual(await projectRelationshipPeers("project", bindings().map(item => ({ ...item, revision: "changed" })), { ...options, background: true }), []);
    assert.equal(calls, 1);
});
test("disabled or oversized scopes never scan and foreign replies never become peers", async () => {
    let calls = 0;
    const client: EngineClientLike = { close() { }, async request() { calls++; return { operation: "engine.pong", engine_version: "0.1.3" }; } };
    assert.deepEqual(await projectRelationshipPeers("disabled", bindings(), { client, env: { GRANTTAP_ENGINE_ENABLED: "0" } }), []);
    assert.deepEqual(await projectRelationshipPeers("oversized", Array.from({ length: 9 }, (_, i) => ({ ...bindings()[0]!, repositoryId: `repo-${i}` })), { client, env: { GRANTTAP_ENGINE_ENABLED: "1" } }), []);
    assert.equal(calls, 0);
    assert.deepEqual(await projectRelationshipPeers("wrong-reply", bindings(), { client, env: { GRANTTAP_ENGINE_ENABLED: "1" } }), []);
    assert.equal(calls, 1);
    const foreign: EngineClientLike = { close() { }, async request() { return parse({ ...graph(), project_id: "foreign" }); } };
    assert.deepEqual(await projectRelationshipPeers("foreign-scope", bindings(), { client: foreign, env: { GRANTTAP_ENGINE_ENABLED: "1" } }), []);
});
