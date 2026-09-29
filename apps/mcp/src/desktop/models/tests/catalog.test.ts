import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { desktopMeshSnapshots } from "../../mesh-project";
import { desktopSelectedMesh } from "../../projection/selected-mesh";
import { resetLocalMeshStore } from "../../../../../bridge/src/mesh/local-remote/local";

test("Mac list and selected Mesh carry fresh provider model metadata without a session scan", async () => {
  const directory = mkdtempSync(join(tmpdir(), "granttap-desktop-models-"));
  const previous = { config: process.env.GRANTTAP_CONFIG_DIR, codex: process.env.GRANTTAP_CODEX_DIR };
  process.env.GRANTTAP_CONFIG_DIR = directory;
  process.env.GRANTTAP_CODEX_DIR = directory;
  resetLocalMeshStore();
  try {
    writeFileSync(join(directory, "project-mesh.json"), JSON.stringify({ version: 1,
      projects: [{ projectId: "picker-mesh", name: "Picker", canonicalRepositoryId: "repo:picker", createdAt: 1 }], tasks: [], executions: [],
    }));
    const path = join(directory, "models_cache.json");
    const save = (id: string, time = Date.now()) => writeFileSync(path, JSON.stringify({
      fetched_at: new Date(time).toISOString(), models: [
        { slug: id, visibility: "list", display_name: "Current coding model", description: "Provider role", priority: 0 },
        { slug: "hidden-review", visibility: "hide", base_instructions: "private provider payload" },
      ],
    }));
    save("gpt-6-sol");
    const list = desktopMeshSnapshots().snapshots;
    const selected = await desktopSelectedMesh("picker-mesh");
    for (const snapshot of [list[0], selected]) {
      assert.ok(snapshot);
      const catalog = snapshot.modelCatalog?.[0];
      assert.equal(catalog?.models[0]?.modelId, "gpt-6-sol");
      assert.equal(catalog?.models[0]?.description, "Provider role");
      assert.equal(catalog?.models[0]?.endpointId, snapshot.publisherEndpointId);
      assert.equal(catalog?.models.length, 1);
      assert.doesNotMatch(JSON.stringify(snapshot), /private provider payload/);
    }
    save("future-coding-model");
    assert.equal(desktopMeshSnapshots().snapshots[0]?.modelCatalog?.[0]?.models[0]?.modelId, "future-coding-model");
    save("removed-model", Date.now() - 25 * 60 * 60_000);
    const expired = desktopMeshSnapshots().snapshots[0]?.modelCatalog?.[0];
    assert.equal(expired?.stale, true);
    assert.deepEqual(expired?.models, []);
  } finally {
    resetLocalMeshStore();
    for (const [key, value] of [["GRANTTAP_CONFIG_DIR", previous.config], ["GRANTTAP_CODEX_DIR", previous.codex]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
