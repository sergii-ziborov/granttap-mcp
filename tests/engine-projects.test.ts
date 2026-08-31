import assert from "node:assert/strict";
import test from "node:test";
import { syncProjectBinding } from "../apps/bridge/src/engine/engine-projects";
import type { EngineClientLike } from "../apps/bridge/src/engine/engine-supervisor";
import type { EngineOperation, EngineResult } from "../apps/bridge/src/engine/engine-protocol";

const project = {
  projectId: "applydjinn",
  name: "ApplyDjinn",
  canonicalRepositoryId: "github.com/example/frontend",
  createdAt: 1_800_000_000_000,
};

const local = {
  summary: {
    bindingId: "mac-frontend",
    projectId: "applydjinn",
    endpointId: "macbook",
    repositoryId: "github.com/example/frontend",
    displayName: "Frontend",
    available: true,
    revision: "a".repeat(40),
  },
  localRoot: "/work/frontend",
  canonicalRemote: "https://token@github.com/example/frontend?secret=yes",
  lastSeenAt: 1_800_000_000_100,
} as const;

test("disabled Project engine receives no binding record", async () => {
  let calls = 0;
  const client = fakeClient(async () => {
    calls += 1;
    throw new Error("must not run");
  });
  assert.equal(await syncProjectBinding(project, local, { env: {}, client }), false);
  assert.equal(calls, 0);
});

test("enabled Project sync sends local detail only through engine IPC", async () => {
  let operation: EngineOperation | undefined;
  const client = fakeClient(async (input) => {
    operation = input;
    if (input.operation !== "project.upsert_binding") throw new Error("unexpected operation");
    return { operation: "project.binding_upserted", binding: input.input.binding };
  });
  assert.equal(await syncProjectBinding(project, local, {
    env: { GRANTTAP_ENGINE_ENABLED: "1" }, client,
  }), true);
  assert.equal(operation?.operation, "project.upsert_binding");
  if (operation?.operation !== "project.upsert_binding") assert.fail("binding operation required");
  assert.equal(operation.input.binding.local_root, "/work/frontend");
  assert.equal(operation.input.binding.canonical_remote, "github.com/example/frontend");
  assert.equal(operation.input.project.name, "ApplyDjinn");
});

test("Project binding sync preserves legacy behavior when IPC fails", async () => {
  const client = fakeClient(async () => { throw new Error("offline"); });
  assert.equal(await syncProjectBinding(project, local, {
    env: { GRANTTAP_ENGINE_ENABLED: "true" }, client,
  }), false);
});

function fakeClient(
  request: (operation: EngineOperation) => Promise<EngineResult>,
): EngineClientLike {
  return { request, close: () => undefined };
}
