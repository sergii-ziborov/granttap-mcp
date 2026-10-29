import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryDetails } from "..";
import { inspectRepositoryAsync } from "../../catalog";
import type { MeshSnapshot } from "../../../../../../packages/protocol/schema";

test("repository history shares the native Git budget with checkout inspection", async t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-details-budget-"));
  const repo = join(root, "repo"), bin = join(root, "bin"), calls = join(root, "calls");
  mkdirSync(repo); mkdirSync(bin);
  execFileSync("/usr/bin/git", ["init", "-q", repo]);
  writeFileSync(join(bin, "git"), `#!/bin/sh
printf 'start\n' >> '${calls}'
sleep 0.04
/usr/bin/git "$@"
result=$?
printf 'end\n' >> '${calls}'
exit "$result"
`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; rmSync(root, { recursive: true, force: true }); });
  const snapshot = { type: "mesh.snapshot", projectId: "p", sessionId: "p",
    project: { projectId: "p", name: "Fixture", canonicalRepositoryId: `local:${repo}`, createdAt: 1 },
    bindings: [{ bindingId: "b", projectId: "p", endpointId: "mac", repositoryId: `local:${repo}`,
      displayName: "Fixture", available: true, localPathHint: repo }],
    tasks: [], executions: [], claims: [], dependencies: [], events: [], generatedAt: 1 } as MeshSnapshot;
  await Promise.all([repositoryDetails(snapshot, "mac"), inspectRepositoryAsync(join(root, "other"))]);
  let active = 0, maximum = 0;
  for (const line of readFileSync(calls, "utf8").trim().split("\n")) {
    active += line === "start" ? 1 : -1;
    maximum = Math.max(maximum, active);
  }
  assert.equal(active, 0);
  assert.ok(maximum <= 2, `Observed ${maximum} concurrent native Git processes`);
});
