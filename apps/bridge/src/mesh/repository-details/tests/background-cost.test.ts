import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryDetails } from "..";
import type { MeshSnapshot } from "../../../../../../packages/protocol/schema";

test("background observations reuse Git history while still reporting a newly edited file", async t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-background-history-"));
  const repo = join(root, "repo"), bin = join(root, "bin"), calls = join(root, "history-calls");
  mkdirSync(repo); mkdirSync(bin);
  const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q"); writeFileSync(join(repo, "source.txt"), "before\n"); git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Fixture");
  writeFileSync(calls, "");
  writeFileSync(join(bin, "git"), `#!/bin/sh
case "$*" in *"log -8"*|*"shortlog"*|*"rev-list"*) printf h >> '${calls}';; esac
exec /usr/bin/git "$@"
`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; rmSync(root, { recursive: true, force: true }); });
  const snapshot = { type: "mesh.snapshot", projectId: "p", sessionId: "p",
    project: { projectId: "p", name: "Fixture", canonicalRepositoryId: `local:${repo}`, createdAt: 1 },
    bindings: [{ bindingId: "b", projectId: "p", endpointId: "mac", repositoryId: `local:${repo}`,
      displayName: "Fixture", available: true, localPathHint: repo }],
    tasks: [], executions: [], claims: [], dependencies: [], events: [], generatedAt: 1 } as MeshSnapshot;
  const [initial, overlap] = await Promise.all([
    repositoryDetails(snapshot, "mac", { background: true }),
    repositoryDetails(snapshot, "mac", { background: true }),
  ]);
  const first = initial[0]!;
  assert.deepEqual(first.commits, overlap[0]!.commits);
  assert.equal(first.dirty, false);
  assert.equal(first.commits[0]?.subject, "Fixture");
  const historyReads = readFileSync(calls, "utf8").length;
  assert.equal(historyReads, 3);
  writeFileSync(join(repo, "source.txt"), "after\n");
  const second = (await repositoryDetails(snapshot, "mac", { background: true }))[0]!;
  assert.equal(second.dirty, true, "Background caching must preserve fresh uncommitted work");
  assert.equal(first.dirty, false, "A published observation remains immutable");
  assert.equal(readFileSync(calls, "utf8").length, historyReads,
    "The same background revision must not spawn another history, shortlog and count probe");
  second.commits[0]!.subject = "Changed only in this returned object";
  assert.equal((await repositoryDetails(snapshot, "mac", { background: true }))[0]!.commits[0]!.subject, "Fixture");
  await repositoryDetails(snapshot, "mac");
  assert.equal(readFileSync(calls, "utf8").length, historyReads + 3,
    "Explicit observation still reads native Git freshly");
  const originalNow = Date.now;
  const later = originalNow() + 31_000;
  try {
    Date.now = () => later;
    await repositoryDetails(snapshot, "mac", { background: true });
    assert.equal(readFileSync(calls, "utf8").length, historyReads + 6, "Expired background history is reread");
    Date.now = () => 0;
    await repositoryDetails(snapshot, "mac", { background: true });
    assert.equal(readFileSync(calls, "utf8").length, historyReads + 9, "A backwards clock cannot freeze the cache");
  } finally { Date.now = originalNow; }
});
