import assert from "node:assert/strict";
import test from "node:test";
import { syncProjectBinding } from "../engine-projects";
import { EngineRemoteError } from "../../protocol/transport/protocol-base";
import type { EngineClientLike } from "../engine-supervisor";
import type { EngineProjectBinding } from "../../protocol/engine-protocol";

const project = { projectId: "timestamp-fixture", name: "Timestamp fixture",
  canonicalRepositoryId: "github.com/example/timestamps", createdAt: 1_791_800_000_000.75 };
const local = { summary: { bindingId: "checkout", projectId: project.projectId,
  endpointId: "fixture-mac", repositoryId: project.canonicalRepositoryId,
  displayName: "Fixture", available: true }, lastSeenAt: 1_791_800_000_001.25 };

function integerBindingService() {
  let saved: EngineProjectBinding | undefined;
  let createdAt: number | undefined;
  const client: EngineClientLike = { request: async operation => {
    if (operation.operation !== "project.upsert_binding") throw new Error("unexpected operation");
    const { project, binding } = operation.input;
    if (![project.created_at, binding.last_seen_at].every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw new EngineRemoteError("INVALID_REQUEST", "Engine timestamps must satisfy the u64 wire contract");
    }
    saved = binding;
    createdAt = project.created_at;
    return { operation: "project.binding_upserted", binding };
  }, close() {} };
  return { client, binding: () => saved, createdAt: () => createdAt };
}

test("fractional provider timestamps admit the same checkout through the integer Engine contract", async () => {
  const service = integerBindingService();
  assert.equal(await syncProjectBinding(project, local, {
    env: { GRANTTAP_ENGINE_ENABLED: "1" }, client: service.client,
  }), true);
  assert.equal(service.binding()?.binding_id, "checkout");
  assert.equal(service.binding()?.repository_id, project.canonicalRepositoryId);
  assert.equal(service.binding()?.last_seen_at, 1_791_800_000_001);
  assert.equal(service.createdAt(), 1_791_800_000_000);
  assert.equal(project.createdAt, 1_791_800_000_000.75);
  assert.equal(local.lastSeenAt, 1_791_800_000_001.25);
});

test("invalid provider timestamps never create an Engine binding", async () => {
  for (const value of [NaN, Infinity, -0.25, Number.MAX_SAFE_INTEGER + 1]) {
    const service = integerBindingService();
    assert.equal(await syncProjectBinding({ ...project, createdAt: value }, local, {
      env: { GRANTTAP_ENGINE_ENABLED: "1" }, client: service.client,
    }), false);
    assert.equal(service.binding(), undefined);
  }
});

test("zero epochs remain valid and an invalid observation cannot update a binding", async () => {
  const service = integerBindingService();
  const options = { env: { GRANTTAP_ENGINE_ENABLED: "1" }, client: service.client };
  assert.equal(await syncProjectBinding({ ...project, createdAt: 0 }, { ...local, lastSeenAt: 0 }, options), true);
  assert.equal(service.createdAt(), 0);
  assert.equal(service.binding()?.last_seen_at, 0);
  assert.equal(await syncProjectBinding(project, { ...local, lastSeenAt: Infinity }, options), false);
  assert.equal(service.binding()?.last_seen_at, 0);
});
