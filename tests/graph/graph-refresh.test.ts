import assert from "node:assert/strict";
import test from "node:test";
import type { MeshSnapshot } from "../../packages/protocol/schema";
import { requestProjectGraphRefresh } from "../../apps/bridge/src/monitor/graph-refresh";
import { analyzeProjectGraphNow } from "../../apps/bridge/src/mesh/runtime";
test("Graph refresh coalesces one Project without blocking another", async () => {
    const requests: string[] = [];
    let finish: (value: boolean) => void = () => undefined;
    const pending = new Promise<boolean>((resolve) => { finish = resolve; });
    const analyze = async (_client: unknown, projectId: string) => {
        requests.push(projectId);
        return projectId === "first" ? pending : true;
    };
    assert.equal(requestProjectGraphRefresh({} as never, "first", analyze), true);
    assert.equal(requestProjectGraphRefresh({} as never, "first", analyze), false);
    assert.equal(requestProjectGraphRefresh({} as never, "second", analyze), true);
    assert.deepEqual(requests, ["first", "second"]);
    finish(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requestProjectGraphRefresh({} as never, "first", analyze), true);
    finish(true);
});
test("explicit Graph build refreshes one admitted Project and reports missing bindings", async () => {
    const snapshot: MeshSnapshot = {
        type: "mesh.snapshot", sessionId: "project", projectId: "project",
        project: { projectId: "project", name: "Repository", canonicalRepositoryId: "repo", createdAt: 1 },
        tasks: [], executions: [], claims: [], dependencies: [], events: [], generatedAt: 1,
    };
    const sent: MeshSnapshot[] = [];
    const calls: string[] = [];
    const dependencies = {
        snapshots: () => [snapshot],
        wait: async (projectId: string) => { calls.push(`wait:${projectId}`); },
        backbone: async (projectId: string) => {
            calls.push(`backbone:${projectId}`);
            return undefined;
        },
        graphs: async (projectId: string, bindings: NonNullable<MeshSnapshot["bindings"]>, options?: {
            background?: boolean;
        }) => {
            calls.push(`graphs:${projectId}:${bindings.length}:${options?.background}`);
            return [];
        },
        send: async (_client: unknown, value: MeshSnapshot) => { sent.push(value); },
    };
    assert.equal(await analyzeProjectGraphNow({} as never, "other", dependencies), false);
    assert.equal(await analyzeProjectGraphNow({} as never, "project", dependencies, new Set(["request-one", "request-two"])), true);
    assert.deepEqual(calls, ["wait:project", "backbone:project", "graphs:project:0:false"]);
    assert.equal(sent[0]?.projectId, "project");
    assert.deepEqual(sent.map(snapshot => snapshot.graphAnalysisRequestId), ["request-one", "request-two"]);
    assert.equal(sent[0]?.repositoryGraphs?.[0]?.analysisErrorCode, "REPOSITORY_NOT_BOUND");
    assert.equal(sent[0]?.repositoryGraphs?.[0]?.analysisStatus, "UNAVAILABLE");
    assert.ok((sent[0]?.generatedAt ?? 0) > snapshot.generatedAt);
});
test("an explicit Graph request starts while the catalog publisher is still busy", async (t) => {
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { saveRuntimeConfig } = await import("../../apps/bridge/src/config");
    const { localMeshStore } = await import("../../apps/bridge/src/mesh/local-remote/local");
    const { handleMonitorMessage } = await import("../../apps/bridge/src/monitor/handlers/inbound");
    const root = mkdtempSync(join(tmpdir(), "granttap-graph-request-"));
    const names = ["GRANTTAP_CONFIG_DIR", "GRANTTAP_ENGINE_ENABLED", "GRANTTAP_CLAUDE_PROJECTS_DIR",
        "GRANTTAP_CODEX_DIR", "GRANTTAP_CODEX_SESSIONS_DIR", "GRANTTAP_CURSOR_TRANSCRIPTS_DIR", "GRANTTAP_GROK_SESSIONS_DIR"];
    const prior = Object.fromEntries(names.map(n => [n, process.env[n]]));
    for (const n of names)
        process.env[n] = root;
    process.env.GRANTTAP_ENGINE_ENABLED = "0";
    mkdirSync(join(root, "empty"));
    t.after(() => {
        for (const n of names) {
            if (prior[n] == null)
                delete process.env[n];
            else
                process.env[n] = prior[n];
        }
        rmSync(root, { recursive: true, force: true });
    });
    saveRuntimeConfig({ meshEnabled: true, providerSettings: { claude: false, codex: false, cursor: false, grok: false } });
    localMeshStore().upsertProject({ projectId: "busy-catalog-project", name: "Test",
        canonicalRepositoryId: "repository", createdAt: 1 });
    const sent: Array<{
        type: string;
    }> = [];
    const client = { room: "test", setSessionKey: () => { },
        sendSession: async (p: {
            type: string;
        }) => { sent.push(p); },
        send: async (p: {
            type: string;
        }) => { sent.push(p); } };
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const work = handleMonitorMessage(client as never, { type: "sessions.refresh", graphProjectId: "busy-catalog-project", createdAt: 1 }, { leadership: { acquire: () => true }, subscriptions: new Set(), publish: () => blocked });
    try {
        for (let i = 0; i < 30 && !sent.some(p => p.type === "mesh.snapshot"); i++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(sent.some(p => p.type === "mesh.snapshot"), "graph result must not wait for a catalog scan");
    }
    finally {
        release();
        await work;
        await new Promise(resolve => setImmediate(resolve));
    }
});
test("coalesced architecture builds retain every requesting controller receipt", async () => {
    let release!: (value: boolean) => void;
    const held = new Promise<boolean>(resolve => { release = resolve; });
    let receipts: ReadonlySet<string> | undefined;
    const analyze: typeof analyzeProjectGraphNow = async (_client, _project, _dependencies, requested) => {
        receipts = requested;
        return held;
    };
    assert.equal(requestProjectGraphRefresh({} as never, "receipt-project", analyze, "first-controller"), true);
    assert.equal(requestProjectGraphRefresh({} as never, "receipt-project", analyze, "second-controller"), false);
    try {
        assert.deepEqual([...(receipts ?? [])], ["first-controller", "second-controller"]);
    }
    finally {
        release(true);
        await new Promise(resolve => setImmediate(resolve));
    }
});
test("Graph refresh publishes bounded static contracts without changing verified Backbone facts", async () => {
    const snapshot: MeshSnapshot = { type: "mesh.snapshot", sessionId: "links", projectId: "links",
        project: { projectId: "links", name: "Project", canonicalRepositoryId: "api", createdAt: 1 },
        tasks: [], executions: [], claims: [], dependencies: [], events: [], generatedAt: 1,
        bindings: ["api", "client"].map(repositoryId => ({ bindingId: repositoryId, projectId: "links",
            endpointId: "mac", repositoryId, displayName: repositoryId, available: true })),
    };
    const contract = { projectId: "links", repositoryId: "client", peer: "api", via: "api" as const,
        relation: "shares" as const, through: "Weavatrix: static HTTP contract; runtime target unverified", updatedAt: 2 };
    const sent: MeshSnapshot[] = [];
    let scans = 0;
    const dependencies = { snapshot: () => snapshot, wait: async () => { }, backbone: async () => undefined,
        graphs: async () => [], relationships: async (projectId: string, bindings: NonNullable<MeshSnapshot["bindings"]>, options?: {
            background?: boolean;
        }) => {
            scans++;
            assert.equal(projectId, "links");
            assert.equal(bindings.length, 2);
            assert.equal(options?.background, false);
            return [contract];
        }, send: async (_client: unknown, value: MeshSnapshot) => { sent.push(value); },
    };
    assert.equal(await analyzeProjectGraphNow({} as never, "links", dependencies), true);
    assert.equal(scans, 1);
    assert.deepEqual(sent[0]?.peers, [contract]);
    assert.equal(sent[0]?.backbone, undefined);
});
