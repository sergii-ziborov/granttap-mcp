import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectRepository, inspectRepositoryAsync } from "..";

test("asynchronous repository facts match native inspection and missing repositories stay unknown", async t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-async-repository-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/example/repository.git"]);
  assert.deepEqual(await inspectRepositoryAsync(root), inspectRepository(root));
  const missing = join(root, "missing");
  assert.deepEqual(await inspectRepositoryAsync(missing), inspectRepository(missing));
  await Promise.all([inspectRepositoryAsync("invalid\0first"), inspectRepositoryAsync("invalid\0second")]);
  assert.deepEqual(await inspectRepositoryAsync(root), inspectRepository(root),
    "Unstartable commands release their slots for subsequent real inspections");
});

test("overlapping repository inspections share current work and bound native subprocesses", async t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-async-git-bound-"));
  const repo = join(root, "repo"), bin = join(root, "bin"), calls = join(root, "calls");
  mkdirSync(repo); mkdirSync(bin);
  execFileSync("/usr/bin/git", ["init", "-q", repo]);
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf 'start\n' >> '${calls}'\nsleep 0.03\n/usr/bin/git "$@"\nresult=$?\nprintf 'end\n' >> '${calls}'\nexit "$result"\n`, { mode: 0o700 });
  const prior = process.env.PATH;
  process.env.PATH = `${bin}:${prior}`;
  t.after(() => { process.env.PATH = prior; rmSync(root, { recursive: true, force: true }); });
  const first = inspectRepositoryAsync(repo);
  assert.equal(inspectRepositoryAsync(repo), first, "Only active work can be shared");
  const [facts] = await Promise.all([first, inspectRepositoryAsync(join(root, "missing"))]);
  assert.ok(facts.worktree);
  let active = 0, maximum = 0;
  const events = readFileSync(calls, "utf8").trim().split("\n");
  for (const event of events) { active += event === "start" ? 1 : -1; maximum = Math.max(maximum, active); }
  assert.equal(active, 0);
  assert.ok(maximum <= 2, `Observed ${maximum} simultaneous Git subprocesses`);
  assert.equal(events.filter(event => event === "start").length, 8);
  const before = events.length;
  await inspectRepositoryAsync(repo);
  assert.ok(readFileSync(calls, "utf8").trim().split("\n").length > before,
    "A completed lookup is not reused after the repository may have changed");
});
