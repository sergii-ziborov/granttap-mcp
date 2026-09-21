import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RelayClient } from "../../packages/core/relay-client";
import { MeshInvocationPage, MeshInvocationQuery } from "../../packages/protocol/schema";
import { handleInvocationQuery, invocationReply } from "../../apps/bridge/src/engine/invocation/query";
import { localMeshStore, resetLocalMeshStore } from "../../apps/bridge/src/mesh/local-remote/local";

const query = MeshInvocationQuery.parse({
  type: "mesh.invocation.query", sessionId: "project", projectId: "project",
  taskId: "task", requestId: "request", tail: true, limit: 16,
});

test("Invocation query and page stay under the Project key and Task scope", () => {
  const event = {
    event_id: "event", invocation_id: "invocation", project_id: "project",
    task_id: "task", execution_id: "execution", provider: "claude",
    native_call_id: "native", session_id: "session", tool_name: "Edit",
    phase: "reported_failure" as const, source: "transcript" as const,
    occurred_at: 1,
  };
  const reply = invocationReply(query, {
    events: [{ sequence: 4, event }], next_sequence: 4, previous_sequence: 4,
    has_more: false, has_older: true,
  }, "computer", 2);
  assert.equal(MeshInvocationPage.parse(reply).events[0]?.event.session_id, "session");
  assert.equal(MeshInvocationPage.safeParse({ ...reply, sessionId: "task" }).success, false);
  assert.equal(MeshInvocationPage.safeParse({
    ...reply, events: [{ sequence: 4, event: { ...event, task_id: "other" } }],
  }).success, false);
  assert.equal(MeshInvocationQuery.safeParse({ ...query, afterSequence: 1 }).success, false);
});

test("Unavailable Engine is explicit rather than a fabricated empty history", () => {
  const reply = MeshInvocationPage.parse(invocationReply(query, undefined, "computer", 2));
  assert.equal(reply.availability, "unavailable");
  assert.deepEqual(reply.events, []);
});

test("Invocation history refuses an unknown Task before attempting delivery", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-invocation-query-"));
  const previousConfig = process.env.GRANTTAP_CONFIG_DIR;
  const previousEngine = process.env.GRANTTAP_ENGINE_ENABLED;
  process.env.GRANTTAP_CONFIG_DIR = root;
  process.env.GRANTTAP_ENGINE_ENABLED = "0";
  resetLocalMeshStore();
  t.after(() => {
    resetLocalMeshStore();
    if (previousConfig == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previousConfig;
    if (previousEngine == null) delete process.env.GRANTTAP_ENGINE_ENABLED;
    else process.env.GRANTTAP_ENGINE_ENABLED = previousEngine;
    rmSync(root, { recursive: true, force: true });
  });
  const client = {} as RelayClient;
  assert.equal(await handleInvocationQuery(client, query), false);
  const store = localMeshStore();
  store.upsertProject({
    projectId: "project", name: "GrantTap", canonicalRepositoryId: "repo", createdAt: 1,
  });
  assert.equal(await handleInvocationQuery(client, query), false);
  store.upsertTask({
    taskId: "task", projectId: "project", title: "Recover", goal: "Preserve history",
    state: "working", createdAt: 1, updatedAt: 2,
  });
  assert.equal(await handleInvocationQuery(client, query), true,
    "the existing Task receives an explicit unavailable page if Engine is off");
});
