import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EngineFrameDecoder, encodeEngineFrame } from "../../../engine/protocol/engine-protocol";
import type { Payload } from "../../../../../../packages/protocol/schema";
import type { SendOptions } from "../../../../../../packages/core/relay-client";

// Private socket and persisted Mesh; these tests never open the owner's runtime.
const directory = mkdtempSync(join(tmpdir(), "gt-knowledge-"));
process.env.GRANTTAP_CONFIG_DIR = directory;
process.env.GRANTTAP_ENGINE_ENABLED = "1";
const { currentProjectKnowledge, desktopProjectKnowledge, handleProjectKnowledgeQuery } = await import("../runtime-read");
const { localMeshStore } = await import("../../local-remote/local");
const query = { type: "mesh.knowledge.query" as const, sessionId: "project",
  projectId: "project", requestId: "read" };

test("desktop and authenticated relay reads share persisted Project evidence through Engine IPC", async () => {
  const sockets = new Set<Socket>();
  const operations: string[] = [];
  let memoryFails = false;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const decoder = new EngineFrameDecoder();
    socket.on("data", chunk => {
      for (const request of decoder.push(chunk)) {
        operations.push(String(request.operation));
        const result = request.operation === "memory.history"
          ? { operation: "memory.history", page: { project_id: "project", entries: [],
            incomplete: false, next_before_version: null } }
          : { operation: "invocation.history", page: { events: [], next_sequence: 0,
            previous_sequence: 0, has_more: false, has_older: false } };
        socket.write(encodeEngineFrame({ protocol_version: 1, request_id: request.request_id,
          ...(memoryFails && request.operation === "memory.history"
            ? { status: "error", error: { code: "UNAVAILABLE", message: "Memory unavailable" } }
            : { status: "ok", result }) }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(join(directory, "engine.sock"), resolve));
  try {
    localMeshStore().upsertProject({ projectId: "project", name: "Project",
      canonicalRepositoryId: "repository", createdAt: 1 });
    assert.equal(await desktopProjectKnowledge({ project_id: "other", request_id: "read" }), undefined);
    assert.equal(await desktopProjectKnowledge(null), undefined);
    const page = await desktopProjectKnowledge({ project_id: "project", request_id: "read" });
    assert.equal(page?.type, "mesh.knowledge.page");
    assert.equal(page?.memoryAvailability, "ready");
    assert.equal(page?.invocationAvailability, "ready");
    assert.deepEqual(new Set(operations), new Set(["memory.history", "invocation.history"]));
    const sent: Array<{ payload: Payload; options?: SendOptions }> = [];
    const client = {
      setSessionKey: () => {},
      send: async (payload: Payload, _to: unknown, options: SendOptions) => { sent.push({ payload, options }); },
      sendSession: async (payload: Payload, projectId: string, _to: unknown, options: SendOptions) => {
        assert.equal(projectId, "project");
        sent.push({ payload, options });
      },
    };
    assert.equal(await handleProjectKnowledgeQuery(client as never, query), false);
    assert.equal(await handleProjectKnowledgeQuery(client as never, { ...query,
      sessionId: "other", projectId: "other" }, "requester-key"), false);
    assert.equal(await handleProjectKnowledgeQuery(client as never, query, "requester-key"), true);
    assert.deepEqual(sent.map(row => row.payload.type), ["session.key.grant", "mesh.knowledge.page"]);
    assert.ok(sent.every(row => row.options?.peerPublicKey === "requester-key"));
    assert.equal(sent[1]?.options?.reliable, false);
    assert.equal(sent[1]?.options?.ttlMs, 15_000);
    memoryFails = true;
    const partial = await currentProjectKnowledge(query);
    assert.equal(partial?.memoryAvailability, "unavailable");
    assert.equal(partial?.invocationAvailability, "ready");
    process.env.GRANTTAP_ENGINE_ENABLED = "0";
    const offline = await currentProjectKnowledge(query);
    assert.equal(offline?.memoryAvailability, "unavailable");
    assert.equal(offline?.invocationAvailability, "unavailable");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
