import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { computerId } from "../../../../identity/computer";
import { refreshLocalGraphBindings } from "../../binding-sync";
import type { MeshSnapshot } from "../../../../../../../../packages/protocol/schema";

test("Graph checkout admission lets relay callbacks run during native Git inspection", async t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-graph-responsive-"));
  const repo = join(root, "repo"), bin = join(root, "bin");
  mkdirSync(repo); mkdirSync(bin);
  execFileSync("/usr/bin/git", ["init", "-q", repo]);
  const marker = join(root, "relay-callback"), calls = join(root, "git-calls");
  writeFileSync(join(bin, "git"), `#!/bin/sh\nsleep 0.05\nif [ -f '${marker}' ]; then printf async >> '${calls}'; else printf blocked >> '${calls}'; fi\nexec /usr/bin/git "$@"\n`, { mode: 0o700 });
  const names = ["PATH", "GRANTTAP_CONFIG_DIR", "GRANTTAP_ENGINE_ENABLED"];
  const prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.PATH = `${bin}:${prior.PATH}`;
  process.env.GRANTTAP_CONFIG_DIR = root;
  process.env.GRANTTAP_ENGINE_ENABLED = "0";
  t.after(() => {
    for (const name of names) {
      if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name];
    }
    rmSync(root, { recursive: true, force: true });
  });
  const snapshot = { type: "mesh.snapshot", projectId: "responsive", sessionId: "responsive",
    project: { projectId: "responsive", name: "Fixture", canonicalRepositoryId: `local:${repo}`, createdAt: 1 },
    bindings: [{ bindingId: "local", projectId: "responsive", endpointId: computerId(),
      repositoryId: `local:${repo}`, localPathHint: repo, displayName: "Fixture", available: true }],
    tasks: [], executions: [], claims: [], dependencies: [], events: [], generatedAt: 1 } as MeshSnapshot;
  const relayWork = new Promise<void>(resolve => setImmediate(() => { writeFileSync(marker, "received"); resolve(); }));
  await refreshLocalGraphBindings(snapshot);
  await relayWork;
  assert.ok(readFileSync(calls, "utf8").includes("async"),
    "Native Git inspection must not monopolize the relay's event loop");
});
