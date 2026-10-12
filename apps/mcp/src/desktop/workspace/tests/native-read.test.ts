import assert from "node:assert/strict";
import test from "node:test";
import { createConnection } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startDesktopEngineBridge } from "../../engine-bridge";
import { encodeEngineFrame } from "../../../../../bridge/src/engine/protocol/engine-protocol";

function exchange(socketPath: string, input: Record<string, unknown>): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        const chunks: Buffer[] = [];
        socket.setTimeout(2_000, () => { socket.destroy(); reject(Error("Workspace read timed out")); });
        socket.on("data", data => chunks.push(data));
        socket.once("error", reject);
        socket.once("close", () => resolve(Buffer.concat(chunks)));
        socket.once("connect", () => socket.write(encodeEngineFrame({
            protocol_version: 1, request_id: "workspace-read", operation: "desktop.task_workspace", input,
        })));
    });
}

test("the native Mac bridge exposes exact Task workspace files without an Engine/model call", async t => {
    const directory = mkdtempSync("/tmp/granttap-native-workspace-");
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const workspace = join(directory, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "actual.swift"), "let fixture = 42");
    const storePath = join(directory, "mesh.json");
    writeFileSync(storePath, JSON.stringify({ version: 1,
        projects: [{ projectId: "p", name: "Fixture", canonicalRepositoryId: "repo", createdAt: 1 }],
        tasks: [{ taskId: "t", projectId: "p", title: "Files", goal: "Inspect", state: "working", createdAt: 1, updatedAt: 2 }],
        executions: [{ taskId: "t", sessionId: "s", provider: "codex", computerId: "mac", workspace, startedAt: 1 }],
    }));
    let engineCalls = 0;
    const bridge = await startDesktopEngineBridge({ storePath, client: {
        async request() { engineCalls++; throw Error("Workspace reads must not call a model or Engine"); },
        close() {},
    } });
    t.after(() => bridge.close());
    const query = { project_id: "p", task_id: "t", session_id: "s", mode: "file", path: "actual.swift" };
    const bytes = await exchange(bridge.socketPath, query);
    assert.ok(bytes.length > 4, "Native bridge must admit the workspace read operation");
    const frame = JSON.parse(bytes.subarray(4).toString());
    assert.equal(frame.status, "ok");
    assert.equal(frame.result.text, "let fixture = 42");
    assert.equal((await exchange(bridge.socketPath, { ...query, session_id: "other" })).length, 0);
    assert.equal(engineCalls, 0);
});
