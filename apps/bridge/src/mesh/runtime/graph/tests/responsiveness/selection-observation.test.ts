import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { graphAnalysisBindings } from "../../checkout-identity";
import { inspectRepositoryAsync } from "../../../../catalog";
import { repositoryDetails } from "../../../../repository-details";
import type { MeshSnapshot } from "../../../../../../../../packages/protocol/schema";

test("graph selection uses the exact checkout observation admitted for this publication", async t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-graph-observation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  const commit = () => git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "-qm", "Fixture", "--allow-empty");
  commit();
  const admitted = await inspectRepositoryAsync(root);
  commit();
  const now = git("rev-parse", "HEAD");
  assert.notEqual(now, admitted.revision);
  const binding = { bindingId: "b", projectId: "p", endpointId: "mac", repositoryId: `local:${root}`,
    displayName: "Fixture", available: true, localPathHint: root };
  const selected = graphAnalysisBindings([binding], "mac", () => admitted);
  assert.equal(selected[0]?.revision, admitted.revision,
    "A second Git probe can describe a different revision from the admitted snapshot");
  const snapshot = { type: "mesh.snapshot", projectId: "p", sessionId: "p",
    project: { projectId: "p", name: "Fixture", canonicalRepositoryId: binding.repositoryId, createdAt: 1 },
    bindings: [binding], tasks: [], executions: [], claims: [], dependencies: [], events: [], generatedAt: 1 } as MeshSnapshot;
  const details = (await repositoryDetails(snapshot, "mac", { inspect: () => admitted }))[0]!;
  assert.equal(details.revision, admitted.revision);
  assert.equal(details.commits[0]?.sha, admitted.revision,
    "History must describe the admitted commit even after HEAD changes");
});
