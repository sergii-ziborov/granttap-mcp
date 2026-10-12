import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { refreshLocalGraphBindings } from "../binding-sync";
import type { MeshSnapshot } from "../../../../../../../packages/protocol/schema";

test("a verified checkout with failed Engine admission reports failure before analysis", async () => {
  const root = mkdtempSync("/tmp/granttap-binding-admission-");
  const repositoryId = "github.com/example/project";
  const projectId = "project";
  const snapshot = { projectId, project: { projectId, name: "Fixture", canonicalRepositoryId: repositoryId, createdAt: 1 },
    bindings: [{ bindingId: "checkout", projectId, endpointId: "mac", repositoryId,
      displayName: "Fixture", available: true, localPathHint: root }] } as MeshSnapshot;
  try {
    const reports = await refreshLocalGraphBindings(snapshot, {
      endpoint: () => "mac",
      inspect: () => ({ root, worktree: root, canonicalRepositoryId: repositoryId }) as never,
      sync: async () => false,
    });
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.analysisStatus, "UNAVAILABLE");
    assert.equal(reports[0]?.analysisErrorCode, "ENGINE_ADMISSION_UNAVAILABLE");
    assert.equal(reports[0]?.totalNodes, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
