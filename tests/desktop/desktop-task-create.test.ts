import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { desktopTaskCreate } from "../../apps/mcp/src/desktop/delivery/task-create";
import { inspectRepository } from "../../apps/bridge/src/mesh/catalog";
import { MeshStore } from "../../apps/bridge/src/mesh/store";

test("Mac creates a Task only through this Mesh's exact local repository binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "granttap-desktop-task-create-"));
  const storePath = join(root, "project-mesh.json");
  const repository = join(root, "repository");
  execFileSync("git", ["init", "-q", repository]);
  const projectId = `test-${randomUUID()}`, endpoint = "test-computer";
  const identity = inspectRepository(repository);
  const store = new MeshStore(storePath);
  store.upsertProject({ projectId, name: "Test Mesh", repositoryRoot: repository,
    canonicalRepositoryId: identity.canonicalRepositoryId, createdAt: Date.now() });
  store.upsertBinding({ bindingId: "local-binding", projectId, endpointId: endpoint,
    repositoryId: identity.canonicalRepositoryId, displayName: "repository",
    localPathHint: repository, available: true });
  let calls = 0;
  const create = async () => {
    calls++;
    return { ok: true as const, text: "Started", sessionId: "native-session" };
  };
  const request = {
    project_id: projectId, binding_id: "local-binding", endpoint_id: endpoint,
    operation_id: randomUUID(), provider: "codex", text: "Implement feature",
  };
  const wrong = await desktopTaskCreate({ ...request, binding_id: "other" },
    storePath, endpoint, create, () => true) as { created: boolean };
  assert.equal(wrong.created, false);
  assert.equal(calls, 0);
  const result = await desktopTaskCreate(request, storePath, endpoint,
    create, () => true) as { created: boolean; session_id: string };
  assert.equal(result.created, true);
  assert.equal(result.session_id, "native-session");
  assert.equal(calls, 1);
  const repeat = await desktopTaskCreate(request, storePath, endpoint,
    create, () => true) as { created: boolean };
  assert.equal(repeat.created, true);
  assert.equal(calls, 1);
});
