import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProjectPolicy } from "../../../packages/protocol/schema";
import { localMeshStore, resetLocalMeshStore } from "../../../apps/bridge/src/mesh/local-remote/local";
import { persistMeshPolicyExtras } from "../../../apps/bridge/src/project-policy/apply";
import { repoEnvPath } from "../../../apps/bridge/src/mesh/context/env";
import { repoRestrictionsPath } from "../../../apps/bridge/src/mesh/restrictions/store";
import { loadRestrictions, writeRepoRestrictions } from "../../../apps/bridge/src/mesh/restrictions";

test("policy exports and revokes across every available local Project checkout", (t) => {
  process.env.GRANTTAP_CONFIG_DIR = mkdtempSync(join(tmpdir(), "granttap-multi-binding-"));
  resetLocalMeshStore();
  t.after(resetLocalMeshStore);
  const roots = ["api", "client", "remote"].map((name) =>
    mkdtempSync(join(tmpdir(), `granttap-${name}-`)));
  const store = localMeshStore();
  store.upsertProject({ projectId: "project", name: "Test Project",
    canonicalRepositoryId: "repo-api", createdAt: 1 });
  for (const [index, root] of roots.entries()) {
    store.upsertBinding({
      bindingId: `binding-${index}`, projectId: "project",
      endpointId: index === 2 ? "another-mac" : "this-mac",
      repositoryId: `repo-${index}`, displayName: `Repo ${index}`,
      localPathHint: root, available: true,
    });
  }
  const policy: ProjectPolicy = {
    projectId: "project", revision: 1, enforcement: "best_available", rules: [],
    restrictions: { projectId: "project", revision: 1, scope: "project_and_repo",
      rules: [], source: "phone" },
    environment: { projectId: "project", revision: 1, shareNonSecretsWithRepo: true,
      variables: [{ key: "PUBLIC_URL", value: "https://example.test", secret: false },
        { key: "PRIVATE_TOKEN", value: "private", secret: true }] },
  };
  persistMeshPolicyExtras("project", policy, "this-mac");
  for (const root of roots.slice(0, 2)) {
    const contents = readFileSync(repoEnvPath(root), "utf8");
    assert.match(contents, /PUBLIC_URL=/);
    assert.doesNotMatch(contents, /PRIVATE_TOKEN|private/);
    assert.equal(existsSync(repoRestrictionsPath(root)), true);
  }
  assert.equal(existsSync(repoEnvPath(roots[2]!)), false);
  assert.equal(existsSync(repoRestrictionsPath(roots[2]!)), false);
  persistMeshPolicyExtras("project", { ...policy, revision: 2,
    environment: { ...policy.environment!, revision: 2, shareNonSecretsWithRepo: false } },
  "this-mac");
  for (const root of roots.slice(0, 2)) assert.equal(existsSync(repoEnvPath(root)), false);

  const synced: ProjectPolicy = { ...policy, revision: 3,
    restrictions: { projectId: "project", revision: 3, scope: "sync_from_repo",
      rules: [], source: "phone" } };
  assert.throws(() => persistMeshPolicyExtras("project", synced, "this-mac"),
    /one exact local repository binding/);
  writeRepoRestrictions(roots[1]!, { ...synced.restrictions!,
    repositoryId: "repo-1", source: "repo" });
  persistMeshPolicyExtras("project", { ...synced,
    restrictions: { ...synced.restrictions!, repositoryId: "repo-1" } }, "this-mac");
  assert.equal(loadRestrictions("project")?.repositoryId, "repo-1");
  assert.equal(loadRestrictions("project")?.source, "repo");
});
